# Ramen Blog – 서버 (Express + PostgreSQL)

- **역할**: 포스트·댓글·리비전 REST API. 데이터는 **PostgreSQL**에 저장합니다. API는 `http://HOST:PORT/api`.
- **실행**:
  1. `bun install`
  2. PostgreSQL DB 준비 후 `migrate/001_init.sql`, `002_add_banner.sql`, `003_add_description.sql`을 순서대로 적용 (예: `psql "$DATABASE_URL" -f migrate/001_init.sql`). 서버 시작 시 `ensureSchema()`는 `settings` 테이블만 자동 생성하며, `posts`/`comments`/`revisions` 테이블은 위 마이그레이션으로 미리 만들어둬야 합니다.
  3. `bun run dev` 또는 `bun run start` (기본: `http://localhost:3000`)
## 환경 변수

`.env.example`을 복사해 `.env`로 사용하세요.

| 변수 | 필수 | 기본값 | 설명 |
|---|:---:|---|---|
| `DATABASE_URL` | ✅ | – | PostgreSQL 연결 문자열 |
| `PORT` | | `3000` | 서버 포트 |
| `HOST` | | `localhost` | 바인딩 호스트 |
| `RAMEN_ADMIN_PASSWORD` | | – | 설정 시 포스트·리비전 등 관리자 API에 `Authorization: Bearer <비밀번호>` 헤더 필요. 앱에서 블로그 연결 시 같은 비밀번호를 입력하면 됨 |
| `CORS_ORIGIN` | | 로컬 개발용 3종[^1] | 쉼표로 구분된 허용 오리진. credentials 사용 시 필요 |
| `UPLOADS_DIR` | | `./uploads` | 업로드 이미지 저장 경로. Docker/k8s에서는 볼륨을 마운트해 영속화해야 함 |
| `WEB_DIST_DIR` | | – | 웹 빌드 정적 서빙 경로 (Docker 등 단일 이미지 배포 시) |

[^1]: `http://localhost:5173,http://localhost:1420,http://localhost:4321`

## 주요 API

인증 열이 ✅인 엔드포인트는 `RAMEN_ADMIN_PASSWORD` 설정 시 `Authorization: Bearer <비밀번호>` 헤더가 필요합니다.

**Posts**

| Method | Path | 설명 | 인증 |
|---|---|---|:---:|
| GET | `/api/posts` | 게시글 목록 | |
| GET | `/api/posts/projects` | 프로젝트 게시글 목록 | |
| GET | `/api/posts/by-slug/:slug` | 슬러그로 게시글 조회 | |
| PATCH | `/api/posts/by-slug/:slug` | 게시글 수정 | ✅ |
| POST | `/api/posts` | 게시글 생성 | ✅ |
| GET | `/api/posts/slugs` | 슬러그·발행 상태 목록 | ✅ |
| PATCH | `/api/posts/slugs` | 슬러그 일괄 변경 | ✅ |
| POST | `/api/posts/ensure` | 게시글 upsert | ✅ |
| POST | `/api/sync/posts` | 앱 체크포인트 sync | ✅ |

**Comments**

| Method | Path | 설명 | 인증 |
|---|---|---|:---:|
| GET | `/api/posts/by-slug/:slug/comments` | 슬러그 기준 댓글 목록 | |
| GET | `/api/posts/:postId/comments` | 게시글 ID 기준 댓글 목록 | |
| GET | `/api/comments` | 전체 댓글 조회 | ✅ |
| POST | `/api/comments` | 댓글 생성 | |
| PUT | `/api/comments/:id` | 댓글 수정 | |
| DELETE | `/api/comments/:id` | 댓글 삭제 | |

**Revisions / Settings / Uploads**

| Method | Path | 설명 | 인증 |
|---|---|---|:---:|
| POST | `/api/posts/:postId/revisions` | 리비전 생성 | ✅ |
| GET | `/api/revisions/:id` | 리비전 조회 | |
| GET | `/api/settings/project-tag` | 프로젝트 태그 조회 | |
| PUT | `/api/settings/project-tag` | 프로젝트 태그 수정 | ✅ |
| POST | `/api/uploads` | 이미지 업로드 (png/jpeg/gif/webp/svg, 최대 8MB) | ✅ |

업로드된 이미지는 `/uploads`에서 정적으로 서빙됩니다.
