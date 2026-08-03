/**
 * Ramen Blog server: HTTP API (posts, comments) + PostgreSQL.
 * - HTTP: http://host:port/api/...
 * - Post sync: POST http://host:port/api/sync/posts
 * When WEB_DIST_DIR is set (e.g. in Docker), also serves static web build at /.
 */
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import cors from "cors";
import express from "express";
import { createApi } from "./api.js";
import { ensureSchema } from "./db.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "localhost";
/** Comma-separated; required when client sends credentials (no '*'). 4321 = Astro dev. */
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173,http://localhost:1420,http://localhost:4321")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 배포 시 설정. 설정 시 포스트·리비전 등 관리자 API에 Authorization: Bearer <값> 필요. */
const ADMIN_PASSWORD = process.env.RAMEN_ADMIN_PASSWORD?.trim() || undefined;
/** 업로드된 이미지 저장 위치. Docker/k8s에서는 볼륨을 마운트해 영속화해야 함. */
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads");

(async () => {
  process.on("warning", (warning) => {
    if (warning.name === "MaxListenersExceededWarning") {
      console.warn("[ramen] listener warning:", warning.message);
      if (warning.stack) console.warn(warning.stack);
    }
  });

  await ensureSchema();
  mkdirSync(UPLOADS_DIR, { recursive: true });

  const app = createApi({
    corsOrigins: CORS_ORIGINS,
    adminPassword: ADMIN_PASSWORD,
    uploadsDir: UPLOADS_DIR,
  });
  app.use("/uploads", express.static(UPLOADS_DIR));

  const server = http.createServer(app);

  server.on("connection", (socket) => {
    if (process.env.RAMEN_DEBUG_TCP !== "1") return;
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[ramen] tcp open  ${addr}`);
    socket.once("close", () => {
      console.log(`[ramen] tcp close ${addr} (close-listeners=${socket.listenerCount("close")})`);
    });
  });

  // Serve web: SSR handler when web build has server/entry.mjs, else static + index.html fallback.
  const webDistDir = process.env.WEB_DIST_DIR || path.join(process.cwd(), "web-dist");
  const serverEntry = path.join(webDistDir, "server", "entry.mjs");
  if (existsSync(webDistDir)) {
    if (existsSync(serverEntry)) {
      const clientDir = path.join(webDistDir, "client");
      if (existsSync(clientDir)) {
        app.use(express.static(clientDir));
      }
      const { handler: ssrHandler } = await import(pathToFileURL(serverEntry).href);
      app.use((req, res, next) => {
        if (req.path.startsWith("/api")) return next();
        (ssrHandler as (req: express.Request, res: express.Response, next: express.NextFunction) => void)(req, res, next);
      });
    } else {
      app.use(express.static(webDistDir));
      app.get("*", (_req, res) => res.sendFile(path.join(webDistDir, "index.html")));
    }
  }

  server.listen(PORT, HOST, () => {
    console.log("[ramen] API http://" + HOST + ":" + PORT + "/api");
    console.log("[ramen] Post sync POST http://" + HOST + ":" + PORT + "/api/sync/posts");
  });
})().catch((e) => {
  console.error("[ramen] Startup failed:", e);
  process.exit(1);
});
