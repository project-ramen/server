/**
 * PostgreSQL connection and document types (formerly rxdb.ts).
 */
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL must be set for the ramen server (PostgreSQL).");
}

export const sql = postgres(connectionString, { max: 10 });

/** 앱 전역 설정 key-value 저장소 (예: project-tag). 없으면 생성. */
export async function ensureSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

export type PostDoc = {
  id: string;
  type: "post";
  slug: string;
  title: string;
  body_md: string;
  published: number;
  tags: string;
  category: string;
  banner?: string | null;
  banner_url?: string | null;
  description?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type CommentDoc = {
  id: string;
  type: "comment";
  post_slug: string;
  content: string;
  user_id: string | null;
  start_anchor: number | null;
  end_anchor: number | null;
  created_at: string;
  referenced_snippet?: string | null;
  referenced_text?: string | null;
  password_hash?: string | null;
};

export type RevisionDoc = {
  id: string;
  type: "revision";
  post_slug: string;
  body_md: string;
  created_at: string;
};
