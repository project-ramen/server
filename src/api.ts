import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import multer from "multer";
import { postId, slugToNumericId, commentId, revisionId } from "./docHelpers.js";
import type { JSONValue } from "postgres";
import type { PostDoc, CommentDoc } from "./db.js";
import { sql } from "./db.js";

export type CreateApiOptions = {
  corsOrigins: string[];
  /** 배포 시 설정. 설정 시 포스트·리비전 등 관리자 API에 Authorization: Bearer <값> 필요. */
  adminPassword?: string;
  /** 업로드된 이미지를 저장할 디렉토리 (정적 서빙은 index.ts에서 /uploads 로 처리). */
  uploadsDir: string;
};

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** 관리자 API에 사용할 Authorization 헤더 검사. adminPassword 미설정 시 통과. */
function checkAdminAuth(adminPassword: string | undefined, req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!adminPassword || !adminPassword.trim()) {
    next();
    return;
  }
  const auth = req.headers.authorization;
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token === adminPassword.trim()) {
    next();
    return;
  }
  res.status(401).json({ error: "Admin authentication required" });
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function jsonbToTagStrings(tags: unknown, category: unknown): { tags: string; category: string } {
  const norm = (x: unknown): string[] => {
    if (Array.isArray(x)) return x.filter((t): t is string => typeof t === "string");
    if (typeof x === "string") {
      try {
        const p = JSON.parse(x);
        return Array.isArray(p) ? p.filter((t): t is string => typeof t === "string") : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  return {
    tags: JSON.stringify(norm(tags)),
    category: JSON.stringify(norm(category)),
  };
}

function rowToPostDoc(row: Record<string, unknown>): PostDoc {
  const { tags, category } = jsonbToTagStrings(row.tags, row.category);
  const deletedRaw = row.deleted_at;
  return {
    id: String(row.id),
    type: "post",
    slug: String(row.slug),
    title: String(row.title ?? ""),
    body_md: String(row.body_md ?? ""),
    published: Number(row.published ?? 0),
    tags,
    category,
    banner: row.banner != null ? String(row.banner) : null,
    banner_url: row.banner_url != null ? String(row.banner_url) : null,
    description: row.description != null ? String(row.description) : null,
    deleted_at: deletedRaw != null && deletedRaw !== "" ? iso(deletedRaw as Date | string) : null,
    created_at: iso(row.created_at as Date | string),
    updated_at: iso(row.updated_at as Date | string),
  };
}

export function createApi(options: CreateApiOptions): express.Express {
  const { corsOrigins, adminPassword, uploadsDir } = options;
  const app = express();
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
    })
  );
  app.use(express.json());

  const adminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) =>
    checkAdminAuth(adminPassword, req, res, next);

  function slugNormalize(s: string): string {
    if (!s) return s;
    return s.replace(/\./g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || s;
  }
  function slugFallback(slug: string): string | null {
    if (!slug || !slug.includes(".")) return null;
    return slugNormalize(slug) || null;
  }

  function toPostRow(doc: PostDoc): Record<string, unknown> {
    return {
      id: slugToNumericId(doc.slug),
      slug: doc.slug,
      title: doc.title,
      body_md: doc.body_md ?? "",
      published: doc.published,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      tags: doc.tags ?? "[]",
      category: doc.category ?? "[]",
      banner: doc.banner ?? null,
      banner_url: doc.banner_url ?? null,
      description: doc.description ?? null,
      deleted_at: doc.deleted_at ?? null,
    };
  }

  async function findPostBySlug(slug: string): Promise<PostDoc | null> {
    const rows = await sql`
      SELECT * FROM posts WHERE id = ${postId(slug)}
    `;
    const row = rows[0] as (typeof rows)[0] | undefined;
    return row ? rowToPostDoc(row) : null;
  }

  async function findPostBySlugNormalized(requested: string): Promise<PostDoc | null> {
    let doc = await findPostBySlug(requested);
    if (!doc && slugFallback(requested)) doc = await findPostBySlug(slugFallback(requested)!);
    if (!doc) {
      const norm = slugNormalize(requested);
      const all = await sql`SELECT * FROM posts`;
      const hit = all.find((r) => !r.deleted_at && slugNormalize(r.slug) === norm);
      doc = hit ? rowToPostDoc(hit) : null;
    }
    return doc;
  }

  /** Checkpoint 기반 포스트 동기화 (RxDB replication 대체). */
  app.post("/api/sync/posts", adminAuth, async (req, res) => {
    try {
      const { checkpoint, documents } = req.body as { checkpoint?: string | null; documents?: unknown[] };
      const syncTime = new Date().toISOString();

      const docs = Array.isArray(documents) ? documents : [];
      for (const raw of docs) {
        const doc = raw as Record<string, unknown>;
        const id = typeof doc.id === "string" ? doc.id : "";
        const slug = typeof doc.slug === "string" ? doc.slug : "";
        if (!id || !slug) continue;

        let tags: unknown = doc.tags ?? [];
        let category: unknown = doc.category ?? [];
        if (typeof tags === "string") {
          try {
            tags = JSON.parse(tags);
          } catch {
            tags = [];
          }
        }
        if (typeof category === "string") {
          try {
            category = JSON.parse(category);
          } catch {
            category = [];
          }
        }

        const created_at = typeof doc.created_at === "string" ? doc.created_at : syncTime;
        const updated_at = typeof doc.updated_at === "string" ? doc.updated_at : syncTime;
        const deletedRaw = doc.deleted_at;
        const deleted_at =
          deletedRaw == null || deletedRaw === ""
            ? null
            : typeof deletedRaw === "string"
              ? deletedRaw
              : null;
        const banner = typeof doc.banner === "string" && doc.banner.trim() ? doc.banner : null;
        const bannerUrl = typeof doc.banner_url === "string" && doc.banner_url.trim() ? doc.banner_url : null;
        const description = typeof doc.description === "string" && doc.description.trim() ? doc.description : null;

        await sql`
          INSERT INTO posts (id, type, slug, title, body_md, published, tags, category, banner, banner_url, description, deleted_at, created_at, updated_at)
          VALUES (
            ${id},
            'post',
            ${slug},
            ${String(doc.title ?? "")},
            ${String(doc.body_md ?? "")},
            ${Number(doc.published ?? 0)},
            ${sql.json(tags as JSONValue)},
            ${sql.json(category as JSONValue)},
            ${banner},
            ${bannerUrl},
            ${description},
            ${deleted_at},
            ${created_at}::timestamptz,
            ${updated_at}::timestamptz
          )
          ON CONFLICT (id) DO UPDATE SET
            title       = EXCLUDED.title,
            body_md     = EXCLUDED.body_md,
            published   = EXCLUDED.published,
            tags        = EXCLUDED.tags,
            category    = EXCLUDED.category,
            banner      = EXCLUDED.banner,
            banner_url  = EXCLUDED.banner_url,
            description = EXCLUDED.description,
            deleted_at  = EXCLUDED.deleted_at,
            updated_at  = EXCLUDED.updated_at
          WHERE EXCLUDED.updated_at > posts.updated_at
        `;
      }

      const cp = checkpoint && String(checkpoint).trim() ? String(checkpoint) : null;
      const pulled = cp
        ? await sql`
            SELECT * FROM posts
            WHERE updated_at > ${cp}::timestamptz
            ORDER BY updated_at ASC
          `
        : await sql`
            SELECT * FROM posts
            ORDER BY updated_at ASC
          `;

      const out = pulled.map((row) => {
        const p = rowToPostDoc(row);
        return {
          ...p,
          tags: JSON.parse(p.tags || "[]"),
          category: JSON.parse(p.category || "[]"),
        };
      });

      res.json({ checkpoint: syncTime, documents: out });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  async function getProjectTag(): Promise<string> {
    const rows = await sql`SELECT value FROM settings WHERE key = 'project_tag'`;
    return typeof rows[0]?.value === "string" ? rows[0].value : "";
  }

  async function fetchPublishedPostRows(): Promise<Record<string, unknown>[]> {
    const allPosts = await sql`SELECT * FROM posts`;
    const posts = allPosts.filter((d) => d.deleted_at == null && Number(d.published) === 1);
    const counts = await sql`
      SELECT post_slug, COUNT(*)::int AS n FROM comments GROUP BY post_slug
    `;
    const countMap = new Map(counts.map((c) => [c.post_slug as string, c.n as number]));
    const out = posts.map((d) => {
      const doc = rowToPostDoc(d);
      const slug = d.slug;
      let tags: string[] = [];
      let category: string[] = [];
      try {
        const t = typeof d.tags === "string" ? JSON.parse(d.tags) : d.tags;
        if (Array.isArray(t)) tags = t.filter((x: unknown) => typeof x === "string");
      } catch (_) {}
      try {
        const c = typeof d.category === "string" ? JSON.parse(d.category) : d.category;
        if (Array.isArray(c)) category = c.filter((x: unknown) => typeof x === "string");
      } catch (_) {}
      return {
        ...toPostRow(doc),
        comment_count: countMap.get(slug) ?? 0,
        tags,
        category,
        updated_at: doc.updated_at,
      };
    });
    out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return out;
  }

  app.get("/api/settings/project-tag", async (_req, res) => {
    try {
      res.json({ value: await getProjectTag() });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put("/api/settings/project-tag", adminAuth, async (req, res) => {
    try {
      const { value } = req.body as { value?: unknown };
      const v = typeof value === "string" ? value.trim() : "";
      await sql`
        INSERT INTO settings (key, value, updated_at) VALUES ('project_tag', ${v}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      res.json({ value: v });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/posts", async (_req, res) => {
    // published 상태가 바뀐 직후에도 항상 최신 목록을 받도록 캐시 금지
    // (위키링크 해석용 usePostLinkIndex가 이 목록을 신뢰하고 링크 여부를 결정함)
    res.set("Cache-Control", "no-store");
    try {
      const projectTag = await getProjectTag();
      const out = await fetchPublishedPostRows();
      const filtered = projectTag
        ? out.filter((p) => !(p.tags as string[]).includes(projectTag))
        : out;
      res.json(filtered);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/posts/projects", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const projectTag = await getProjectTag();
      if (!projectTag) return res.json([]);
      const out = await fetchPublishedPostRows();
      res.json(
        out
          .filter((p) => (p.tags as string[]).includes(projectTag))
          .map((p) => ({ ...p, tags: (p.tags as string[]).filter((tag) => tag !== projectTag) }))
      );
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/posts/by-slug/:slug", async (req, res) => {
    try {
      const doc = await findPostBySlugNormalized(req.params.slug);
      if (!doc) return res.status(404).json({ error: "Not found" });
      const row = toPostRow(doc);
      if (doc.deleted_at != null) {
        return res.json({
          id: row.id,
          slug: row.slug,
          title: row.title,
          body_md: row.body_md,
          deleted: true,
          deleted_at: doc.deleted_at,
        });
      }
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.patch("/api/posts/by-slug/:slug", adminAuth, async (req, res) => {
    try {
      const doc = await findPostBySlugNormalized(req.params.slug);
      if (!doc) return res.status(404).json({ error: "Not found" });
      const { deleted, published } = req.body;
      const now = new Date().toISOString();
      if (deleted === true) {
        await sql`
          UPDATE posts SET deleted_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
          WHERE id = ${doc.id}
        `;
        return res.json({ slug: doc.slug, deleted: true });
      }
      if (published === 0) {
        await sql`
          UPDATE posts SET published = 0, updated_at = ${now}::timestamptz WHERE id = ${doc.id}
        `;
        return res.json({ slug: doc.slug, published: 0 });
      }
      if (published === 1) {
        await sql`
          UPDATE posts SET published = 1, updated_at = ${now}::timestamptz WHERE id = ${doc.id}
        `;
        return res.json({ slug: doc.slug, published: 1 });
      }
      return res.status(400).json({ error: "deleted: true or published: 0 or 1 required" });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post("/api/posts", adminAuth, async (req, res) => {
    try {
      const { slug, title, body_md, published, tags, banner, banner_url, description } = req.body;
      if (!slug || !title) return res.status(400).json({ error: "slug and title required" });
      const tagsJson = Array.isArray(tags) ? JSON.stringify(tags.filter((t: unknown) => typeof t === "string")) : "[]";
      const now = new Date().toISOString();
      const tagsParsed = JSON.parse(tagsJson);
      const bannerVal = typeof banner === "string" && banner.trim() ? banner : null;
      const bannerUrlVal = typeof banner_url === "string" && banner_url.trim() ? banner_url : null;
      const descriptionVal = typeof description === "string" && description.trim() ? description : null;
      await sql`
        INSERT INTO posts (id, type, slug, title, body_md, published, tags, category, banner, banner_url, description, created_at, updated_at)
        VALUES (
          ${postId(slug)},
          'post',
          ${slug},
          ${title ?? ""},
          ${body_md ?? ""},
          ${published ? 1 : 0},
          ${sql.json(tagsParsed)},
          ${sql.json([])},
          ${bannerVal},
          ${bannerUrlVal},
          ${descriptionVal},
          ${now}::timestamptz,
          ${now}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          body_md = EXCLUDED.body_md,
          published = EXCLUDED.published,
          tags = EXCLUDED.tags,
          banner = EXCLUDED.banner,
          banner_url = EXCLUDED.banner_url,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at
      `;
      res.status(201).json({ id: slugToNumericId(slug), slug, title });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.patch("/api/posts/slugs", adminAuth, async (req, res) => {
    try {
      const { updates } = req.body as {
        updates?: { oldSlug: string; newSlug: string; newCategory?: string[] }[];
      };
      if (!Array.isArray(updates) || updates.length === 0) return res.status(400).json({ error: "updates array required" });
      const list = updates.filter(
        (u): u is { oldSlug: string; newSlug: string; newCategory?: string[] } =>
          u != null &&
          typeof u.oldSlug === "string" &&
          typeof u.newSlug === "string" &&
          Boolean(u.oldSlug.trim() && u.newSlug.trim())
      );
      if (list.length === 0) return res.status(400).json({ error: "valid updates required" });

      for (const { oldSlug, newSlug, newCategory } of list) {
        if (oldSlug === newSlug) continue;
        const oldRows = await sql`SELECT * FROM posts WHERE id = ${postId(oldSlug)}`;
        const oldRow = oldRows[0];
        if (!oldRow) continue;
        const existingNewRows = await sql`SELECT * FROM posts WHERE id = ${postId(newSlug)}`;
        const existingNew = existingNewRows[0];
        if (existingNew) {
          await sql`DELETE FROM posts WHERE id = ${postId(oldSlug)}`;
          continue;
        }
        const categoryJson =
          Array.isArray(newCategory) && newCategory.every((c) => typeof c === "string")
            ? JSON.stringify(newCategory)
            : jsonbToTagStrings(oldRow.tags, oldRow.category).category;
        const categoryParsed = JSON.parse(categoryJson);
        const oldDoc = rowToPostDoc(oldRow);
        const now = new Date().toISOString();

        await sql.begin(async (t) => {
          await t`
            INSERT INTO posts (id, type, slug, title, body_md, published, tags, category, banner, banner_url, description, deleted_at, created_at, updated_at)
            VALUES (
              ${postId(newSlug)},
              'post',
              ${newSlug},
              ${oldDoc.title},
              ${oldDoc.body_md},
              ${oldDoc.published},
              ${t.json(JSON.parse(oldDoc.tags || "[]") as JSONValue)},
              ${t.json(categoryParsed as JSONValue)},
              ${oldDoc.banner ?? null},
              ${oldDoc.banner_url ?? null},
              ${oldDoc.description ?? null},
              ${oldDoc.deleted_at ?? null},
              ${oldDoc.created_at},
              ${now}
            )
          `;
          await t`
            UPDATE comments SET post_slug = ${newSlug} WHERE post_slug = ${oldSlug}
          `;
          await t`
            UPDATE revisions SET post_slug = ${newSlug} WHERE post_slug = ${oldSlug}
          `;
          await t`DELETE FROM posts WHERE id = ${postId(oldSlug)}`;
        });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // 삭제되지 않은 모든 포스트의 slug/published만 가벼운 페이로드로 반환.
  // 클라이언트가 로컬 vault와 서버 업로드/공개 상태를 대조(marker 표시)하는 용도.
  app.get("/api/posts/slugs", adminAuth, async (_req, res) => {
    try {
      const rows = await sql`
        SELECT slug, published FROM posts WHERE deleted_at IS NULL
      `;
      res.json(rows.map((r) => ({ slug: r.slug, published: Number(r.published) === 1 })));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post("/api/posts/ensure", adminAuth, async (req, res) => {
    try {
      const { slug, title, body_md, published, tags, category, banner, banner_url, description } = req.body;
      if (!slug || typeof slug !== "string") return res.status(400).json({ error: "slug required" });
      const titleStr = title != null ? String(title) : slug;
      const bodyStr = body_md != null ? String(body_md) : "";
      const pub = published ? 1 : 0;
      const tagsJson = Array.isArray(tags) ? JSON.stringify(tags.filter((t: unknown) => typeof t === "string")) : "[]";
      const categoryJson = Array.isArray(category) ? JSON.stringify(category.filter((c: unknown) => typeof c === "string")) : "[]";
      const bannerVal = typeof banner === "string" && banner.trim() ? banner : null;
      const bannerUrlVal = typeof banner_url === "string" && banner_url.trim() ? banner_url : null;
      const descriptionVal = typeof description === "string" && description.trim() ? description : null;
      const now = new Date().toISOString();
      await sql`
        INSERT INTO posts (id, type, slug, title, body_md, published, tags, category, banner, banner_url, description, created_at, updated_at)
        VALUES (
          ${postId(slug)},
          'post',
          ${slug},
          ${titleStr},
          ${bodyStr},
          ${pub},
          ${sql.json(JSON.parse(tagsJson))},
          ${sql.json(JSON.parse(categoryJson))},
          ${bannerVal},
          ${bannerUrlVal},
          ${descriptionVal},
          ${now}::timestamptz,
          ${now}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          body_md = EXCLUDED.body_md,
          published = EXCLUDED.published,
          tags = EXCLUDED.tags,
          category = EXCLUDED.category,
          banner = EXCLUDED.banner,
          banner_url = EXCLUDED.banner_url,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at
      `;
      res.json({ id: slugToNumericId(slug), slug, title: titleStr });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/posts/by-slug/:slug/comments", async (req, res) => {
    try {
      const slugParam = req.params.slug;
      const post_slug = slugParam ? decodeURIComponent(slugParam) : "";
      if (!post_slug) return res.status(400).json({ error: "slug required" });

      const allComments = await sql`
        SELECT * FROM comments WHERE post_slug = ${post_slug} ORDER BY created_at ASC
      `;
      const numericId = slugToNumericId(post_slug);
      const out = allComments.map((d) => ({
        id: slugToNumericId(d.id),
        post_id: numericId,
        content: d.content ?? "",
        user_id: d.user_id ?? null,
        start_anchor: d.start_anchor ?? null,
        end_anchor: d.end_anchor ?? null,
        created_at: iso(d.created_at as Date | string),
        referenced_snippet: d.referenced_snippet ?? null,
        referenced_text: d.referenced_text ?? null,
      }));
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/posts/:postId/comments", async (req, res) => {
    try {
      const postIdParam = req.params.postId;
      const allPosts = await sql`SELECT * FROM posts`;
      let postDoc = allPosts.find((d) => String(slugToNumericId(d.slug)) === postIdParam);
      if (!postDoc && /[.\-]/.test(postIdParam)) {
        const slug = decodeURIComponent(postIdParam);
        postDoc = allPosts.find((d) => !d.deleted_at && d.slug === slug);
      }
      const post_slug = postDoc?.slug;
      if (!post_slug) return res.status(400).json({ error: "invalid postId" });

      const allComments = await sql`
        SELECT * FROM comments WHERE post_slug = ${post_slug} ORDER BY created_at ASC
      `;
      const numericId = slugToNumericId(post_slug);
      const out = allComments.map((d) => ({
        id: slugToNumericId(d.id),
        post_id: numericId,
        content: d.content ?? "",
        user_id: d.user_id ?? null,
        start_anchor: d.start_anchor ?? null,
        end_anchor: d.end_anchor ?? null,
        created_at: iso(d.created_at as Date | string),
        referenced_snippet: d.referenced_snippet ?? null,
        referenced_text: d.referenced_text ?? null,
      }));
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post("/api/posts/:postId/revisions", adminAuth, async (req, res) => {
    try {
      const postIdParam = req.params.postId;
      const { body_md } = req.body;
      if (!postIdParam || body_md == null) return res.status(400).json({ error: "postId and body_md required" });

      const allPosts = await sql`SELECT * FROM posts`;
      const postDoc = allPosts.find((d) => String(slugToNumericId(d.slug)) === postIdParam);
      const post_slug = postDoc?.slug;
      if (!post_slug) return res.status(400).json({ error: "invalid postId" });

      const revId = revisionId(post_slug, Date.now().toString());
      const now = new Date().toISOString();
      await sql`
        INSERT INTO revisions (id, type, post_slug, body_md, created_at)
        VALUES (${revId}, 'revision', ${post_slug}, ${body_md}, ${now}::timestamptz)
      `;
      res.status(201).json({ id: slugToNumericId(revId), post_id: Number(postIdParam) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/revisions/:id", async (req, res) => {
    try {
      const idParam = req.params.id;
      const idNum = parseInt(idParam, 10);
      if (!idNum) return res.status(404).json({ error: "Not found" });
      const allRevs = await sql`
        SELECT * FROM revisions WHERE id LIKE 'revision:%'
      `;
      const rev = allRevs.find((r) => slugToNumericId(r.id) === idNum);
      if (!rev) return res.status(404).json({ error: "Not found" });
      res.json({
        id: idNum,
        post_id: slugToNumericId(rev.post_slug),
        body_md: rev.body_md,
        created_at: iso(rev.created_at as Date | string),
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  function hashCommentPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
  }

  function verifyCommentPassword(stored: string | null | undefined, password: string): boolean {
    if (!stored || !password) return false;
    const i = stored.indexOf(":");
    if (i <= 0) return false;
    const salt = stored.slice(0, i);
    const hash = stored.slice(i + 1);
    const computed = crypto.scryptSync(password, salt, 64).toString("hex");
    return hash === computed;
  }

  app.post("/api/comments", async (req, res) => {
    try {
      const { post_id, post_slug: postSlugParam, content, user_id, start_anchor, end_anchor, password, password_confirm } = req.body;
      if (content == null) return res.status(400).json({ error: "content required" });
      const pw = password != null ? String(password).trim() : "";
      const pwConfirm = password_confirm != null ? String(password_confirm).trim() : "";
      if (!pw) return res.status(400).json({ error: "password required" });
      if (pw !== pwConfirm) return res.status(400).json({ error: "password and password_confirm must match" });

      const allPosts = await sql`SELECT * FROM posts`;
      let postRow: (typeof allPosts)[0] | undefined = undefined;
      const slugFromBody = postSlugParam != null ? String(postSlugParam).trim() : "";
      if (slugFromBody) {
        postRow = allPosts.find((d) => !d.deleted_at && d.slug === slugFromBody);
      }
      if (!postRow && post_id != null) {
        const numId = Number(post_id);
        if (!Number.isNaN(numId)) postRow = allPosts.find((d) => slugToNumericId(d.slug) === numId);
      }
      const post_slug = postRow?.slug ?? (slugFromBody || null);
      if (!post_slug) return res.status(400).json({ error: "post not found" });

      let referenced_snippet: string | null = null;
      let referenced_text: string | null = null;
      const start = start_anchor != null ? parseInt(String(start_anchor), 10) : NaN;
      const end = end_anchor != null ? parseInt(String(end_anchor), 10) : NaN;
      const docForRef = allPosts.find((d) => d.slug === post_slug);
      const bodyForRef = docForRef?.body_md ?? "";
      if (Number.isInteger(start) && Number.isInteger(end) && start < end && bodyForRef) {
        const body = bodyForRef;
        if (body.length >= end) {
          referenced_text = body.slice(start, end);
          const lines = body.split("\n");
          let charIdx = 0;
          let startLine = 0;
          let endLine = 0;
          const endChar = Math.max(start, end - 1);
          for (let i = 0; i < lines.length; i++) {
            const lineLen = lines[i].length + (i < lines.length - 1 ? 1 : 0);
            if (charIdx <= start && start < charIdx + lineLen) startLine = i;
            if (charIdx <= endChar && endChar < charIdx + lineLen) endLine = i;
            charIdx += lineLen;
          }
          const topLines = lines.slice(Math.max(0, startLine - 3), startLine);
          const bottomLines = lines.slice(endLine + 1, Math.min(lines.length, endLine + 4));
          referenced_snippet =
            [topLines.join("\n"), referenced_text, bottomLines.join("\n")].filter(Boolean).join("\n") || null;
        }
      }

      const uuid = crypto.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const cId = commentId(uuid);
      const now = new Date().toISOString();
      const startNum = Number.isInteger(start) ? start : null;
      const endNum = Number.isInteger(end) ? end : null;
      await sql`
        INSERT INTO comments (
          id, type, post_slug, content, user_id, start_anchor, end_anchor,
          created_at, referenced_snippet, referenced_text, password_hash
        )
        VALUES (
          ${cId},
          'comment',
          ${post_slug},
          ${content},
          ${user_id ?? null},
          ${startNum},
          ${endNum},
          ${now}::timestamptz,
          ${referenced_snippet},
          ${referenced_text},
          ${hashCommentPassword(pw)}
        )
      `;
      res.status(201).json({ id: slugToNumericId(cId), post_id: slugToNumericId(post_slug), content });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put("/api/comments/:id", async (req, res) => {
    try {
      const idParam = req.params.id;
      const idNum = parseInt(idParam, 10);
      if (!idNum) return res.status(400).json({ error: "invalid id" });
      const { content, password } = req.body;
      if (content == null) return res.status(400).json({ error: "content required" });
      const pw = password != null ? String(password).trim() : "";
      if (!pw) return res.status(400).json({ error: "password required" });

      const allComments = await sql`
        SELECT * FROM comments WHERE id LIKE 'comment:%'
      `;
      const comment = allComments.find((c) => slugToNumericId(c.id) === idNum) as CommentDoc | undefined;
      if (!comment) return res.status(404).json({ error: "comment not found" });
      if (!verifyCommentPassword(comment.password_hash, pw)) return res.status(403).json({ error: "invalid password" });

      const newContent = String(content).trim();
      await sql`
        UPDATE comments SET content = ${newContent} WHERE id = ${comment.id}
      `;
      res.json({ id: idNum, content: newContent });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.delete("/api/comments/:id", async (req, res) => {
    try {
      const idParam = req.params.id;
      const idNum = parseInt(idParam, 10);
      if (!idNum) return res.status(400).json({ error: "invalid id" });
      const pw = req.body?.password != null ? String(req.body.password).trim() : "";
      if (!pw) return res.status(403).json({ error: "password required" });
      const allComments = await sql`
        SELECT * FROM comments WHERE id LIKE 'comment:%'
      `;
      const comment = allComments.find((c) => slugToNumericId(c.id) === idNum);
      if (!comment) {
        return res.json({ id: idNum, deleted: true, alreadyGone: true });
      }
      if (!verifyCommentPassword(comment.password_hash, pw)) return res.status(403).json({ error: "invalid password" });
      await sql`DELETE FROM comments WHERE id = ${comment.id}`;
      res.json({ id: idNum, deleted: true, alreadyGone: false });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/comments", adminAuth, async (req, res) => {
    try {
      const rows = await sql`
        SELECT c.*, p.title AS post_title
        FROM comments c
        JOIN posts p ON p.slug = c.post_slug
        ORDER BY c.created_at DESC
      `;
      const out = rows.map((d) => ({
        id: slugToNumericId(d.id),
        post_id: slugToNumericId(d.post_slug),
        post_slug: d.post_slug,
        post_title: d.post_title ?? "",
        content: d.content ?? "",
        user_id: d.user_id ?? null,
        created_at: iso(d.created_at as Date | string),
        referenced_snippet: d.referenced_snippet ?? null,
        referenced_text: d.referenced_text ?? null,
      }));
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) => {
        const ext = ALLOWED_IMAGE_TYPES[file.mimetype] ?? path.extname(file.originalname);
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
        cb(new Error("지원하지 않는 이미지 형식입니다."));
        return;
      }
      cb(null, true);
    },
  });

  app.post("/api/uploads", adminAuth, (req, res) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "파일이 없습니다." });
        return;
      }
      res.json({ url: `/uploads/${req.file.filename}` });
    });
  });

  // Handle unknown API routes here so requests do not fall through to Express finalhandler.
  app.use("/api", (req, res) => {
    res.setHeader("Connection", "close");
    res.shouldKeepAlive = false;
    res.status(404).json({
      error: "API route not found",
      method: req.method,
      path: req.originalUrl,
    });
  });

  return app;
}
