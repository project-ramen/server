-- Add description (short summary for project list cards) to posts (see docs/migrate/01-schema.md)

ALTER TABLE posts ADD COLUMN IF NOT EXISTS description TEXT;
