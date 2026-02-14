# Ramen Blog – 실시간 서버 (Yjs WebSocket)

- **역할**: 포스트·댓글 REST API + 포스트별 Yjs 문서 동기화(WebSocket). API는 `http://HOST:PORT/api`, WS는 `ws://HOST:PORT/ws?room=POST_ID`.
- **실행**: `bun run dev` 또는 `bun run start` (기본: `http://localhost:3000`, `ws://localhost:3000/ws`).
- **환경 변수**: `PORT` (기본 3000), `HOST` (기본 localhost), `SQLITE_PATH` (DB 파일 경로, 기본 `./ramen.db`).

클라이언트(y-websocket 등)와 프로토콜이 완전히 호환되도록 하려면 추후 `y-websocket` 의 공식 서버 프로토콜을 맞추거나, 클라이언트에서 이 서버에 맞는 provider를 사용할 수 있음.
