import express from "express";
import cors from "cors";
import { db } from "./db.js";
import { hasEditor } from "./liveRooms.js";

const app = express();
app.use(cors());
app.use(express.json());

// 포스트 목록
app.get("/api/posts", (_req, res) => {
  try {
    const rows = db.query("SELECT id, slug, title, published, created_at, updated_at FROM posts ORDER BY updated_at DESC").all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 해당 slug 방에 작성자(에디터)가 연결되어 있는지 (웹에서 WS vs 정적 선택용)
app.get("/api/posts/by-slug/:slug/live", (req, res) => {
  try {
    const slug = req.params.slug;
    res.json({ live: hasEditor(slug) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 포스트 한 건 (slug)
app.get("/api/posts/by-slug/:slug", (req, res) => {
  try {
    const row = db.query("SELECT * FROM posts WHERE slug = ?").get(req.params.slug);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 포스트 생성 (글쓰기 앱에서 호출)
app.post("/api/posts", (req, res) => {
  try {
    const { slug, title, body_md, published } = req.body;
    if (!slug || !title) return res.status(400).json({ error: "slug and title required" });
    const stmt = db.query(
      "INSERT INTO posts (slug, title, body_md, published) VALUES (?, ?, ?, ?)"
    );
    const result = stmt.run(slug, title ?? "", body_md ?? "", published ? 1 : 0);
    res.status(201).json({ id: result.lastInsertRowid, slug, title });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 포스트 있으면 갱신, 없으면 생성 (앱에서 새 파일 열었을 때 POST 섹션에 바로 노출용)
app.post("/api/posts/ensure", (req, res) => {
  try {
    const { slug, title, body_md, published } = req.body;
    if (!slug || typeof slug !== "string") return res.status(400).json({ error: "slug required" });
    const titleStr = title != null ? String(title) : slug;
    const bodyStr = body_md != null ? String(body_md) : "";
    const pub = published ? 1 : 0;
    const upsert = db.query(
      `INSERT INTO posts (slug, title, body_md, published) VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET title = excluded.title, body_md = excluded.body_md, published = excluded.published, updated_at = datetime('now')`
    );
    upsert.run(slug, titleStr, bodyStr, pub);
    const row = db.query("SELECT id, slug, title FROM posts WHERE slug = ?").get(slug) as { id: number; slug: string; title: string };
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 댓글 목록 (포스트별)
app.get("/api/posts/:postId/comments", (req, res) => {
  try {
    const postId = Number(req.params.postId);
    if (!postId) return res.status(400).json({ error: "invalid postId" });
    const rows = db.query(
      "SELECT id, post_id, content, user_id, start_anchor, end_anchor, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC"
    ).all(postId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 리비전 저장 (글 수정 시 이전 본문 스냅샷; "지워진 부분 자세히 보기"용)
app.post("/api/posts/:postId/revisions", (req, res) => {
  try {
    const postId = Number(req.params.postId);
    const { body_md } = req.body;
    if (!postId || body_md == null) return res.status(400).json({ error: "postId and body_md required" });
    const stmt = db.query("INSERT INTO post_revisions (post_id, body_md) VALUES (?, ?)");
    const result = stmt.run(postId, body_md);
    res.status(201).json({ id: result.lastInsertRowid, post_id: postId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 리비전 한 건 조회 (자세히 보기에서 위 3줄/해당 구간/아래 3줄 등에 사용)
app.get("/api/revisions/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.query("SELECT id, post_id, body_md, created_at FROM post_revisions WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 댓글 작성 (하단 댓글: postId만, 위치 기반: start_anchor, end_anchor 포함)
app.post("/api/comments", (req, res) => {
  try {
    const { post_id, content, user_id, start_anchor, end_anchor } = req.body;
    if (!post_id || content == null) return res.status(400).json({ error: "post_id and content required" });
    const stmt = db.query(
      "INSERT INTO comments (post_id, content, user_id, start_anchor, end_anchor) VALUES (?, ?, ?, ?, ?)"
    );
    const result = stmt.run(post_id, content, user_id ?? null, start_anchor ?? null, end_anchor ?? null);
    res.status(201).json({ id: result.lastInsertRowid, post_id, content });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default app;
