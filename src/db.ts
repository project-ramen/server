import { Database } from "bun:sqlite";
import { join } from "path";

const dbPath = process.env.SQLITE_PATH || join(process.cwd(), "ramen.db");
export const db = new Database(dbPath);

db.run(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body_md TEXT DEFAULT '',
    published INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    user_id TEXT DEFAULT NULL,
    start_anchor TEXT DEFAULT NULL,
    end_anchor TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);

  CREATE TABLE IF NOT EXISTS post_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    body_md TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );
  CREATE INDEX IF NOT EXISTS idx_revisions_post_id ON post_revisions(post_id);
`);
