-- Add banner_url (클릭 시 이동할 링크) to posts — 프로젝트 상세 페이지에서 배너 이미지 클릭 시 사용 (see docs/migrate/01-schema.md)

ALTER TABLE posts ADD COLUMN IF NOT EXISTS banner_url TEXT;
