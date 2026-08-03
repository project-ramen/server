-- Ramen blog — PostgreSQL schema (see migrate/01-schema.md)

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'post',
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  body_md     TEXT NOT NULL DEFAULT '',
  published   SMALLINT NOT NULL DEFAULT 0,
  tags        JSONB NOT NULL DEFAULT '[]',
  category    JSONB NOT NULL DEFAULT '[]',
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_tags_gin ON posts USING GIN (tags);
CREATE INDEX IF NOT EXISTS posts_category_gin ON posts USING GIN (category);
CREATE INDEX IF NOT EXISTS posts_updated_at_idx ON posts (updated_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id                  TEXT PRIMARY KEY,
  type                TEXT NOT NULL DEFAULT 'comment',
  post_slug           TEXT NOT NULL REFERENCES posts(slug) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  user_id             TEXT,
  start_anchor        INT,
  end_anchor          INT,
  referenced_snippet  TEXT,
  referenced_text     TEXT,
  password_hash       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_post_slug_idx ON comments (post_slug);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revisions (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'revision',
  post_slug   TEXT NOT NULL,
  body_md     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revisions_post_slug_created_idx ON revisions (post_slug, created_at DESC);
