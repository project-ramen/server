-- Add banner (image path/URL) to posts — used by project detail pages (see docs/migrate/01-schema.md)

ALTER TABLE posts ADD COLUMN IF NOT EXISTS banner TEXT;
