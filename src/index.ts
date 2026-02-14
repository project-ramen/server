/**
 * Ramen Blog server: HTTP API (posts, comments) + WebSocket (Yjs sync).
 * - HTTP: http://host:port/api/...
 * - WebSocket: ws://host:port/ws?room=POST_ID
 */
import { createServer } from "http";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { getDoc } from "./rooms.js";
import { addEditor, removeEditor } from "./liveRooms.js";
import api from "./api.js";

// DB init (must run before API)
import "./db.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "localhost";

const httpServer = createServer(api);

const wss = new WebSocketServer({ noServer: true });
const roomClients = new Map<string, Set<WebSocket>>();

function getRoomFromUrl(url: string): { roomId: string; isEditor: boolean } {
  try {
    const u = new URL(url, `http://${HOST}`);
    const roomId = u.searchParams.get("room") || "default";
    const isEditor = u.searchParams.get("editor") === "1";
    return { roomId, isEditor };
  } catch {
    return { roomId: "default", isEditor: false };
  }
}

function addToRoom(roomId: string, ws: WebSocket): void {
  if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
  roomClients.get(roomId)!.add(ws);
}

function removeFromRoom(roomId: string, ws: WebSocket): void {
  roomClients.get(roomId)?.delete(ws);
}

function broadcastToRoom(roomId: string, data: Buffer | Uint8Array, exclude?: WebSocket): void {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (const client of clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(payload, { binary: true });
    }
  }
}

function broadcastAwarenessToRoom(roomId: string, data: string): void {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}

httpServer.on("upgrade", (req, socket, head) => {
  const path = req.url?.split("?")[0];
  if (path !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const { roomId, isEditor } = getRoomFromUrl(req.url || "");
  (ws as WebSocket & { _roomId?: string; _isEditor?: boolean })._roomId = roomId;
  (ws as WebSocket & { _roomId?: string; _isEditor?: boolean })._isEditor = isEditor;
  addToRoom(roomId, ws);
  if (isEditor) addEditor(roomId);

  const doc = getDoc(roomId);
  const state = Y.encodeStateAsUpdate(doc);
  if (state.length > 0) {
    ws.send(state, { binary: true });
  }

  ws.on("message", (raw: Buffer | string) => {
    let awarenessStr: string | null = null;
    if (typeof raw === "string") {
      awarenessStr = raw;
    } else if (Buffer.isBuffer(raw)) {
      try {
        awarenessStr = raw.toString("utf8");
      } catch (_) {
        awarenessStr = null;
      }
    }
    if (awarenessStr !== null) {
      try {
        const msg = JSON.parse(awarenessStr) as { type?: string; data?: number[] };
        if (msg.type === "awareness" && Array.isArray(msg.data)) {
          broadcastAwarenessToRoom(roomId, awarenessStr);
          return;
        }
      } catch (_) {
        // not JSON or not awareness — fall through to binary
      }
    }
    if (typeof raw === "string") return;
    if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) return;
    const update = new Uint8Array(raw);
    try {
      Y.applyUpdate(doc, update);
      broadcastToRoom(roomId, update, ws as WebSocket);
    } catch (_) {
      // ignore
    }
  });

  ws.on("close", () => {
    const w = ws as WebSocket & { _roomId?: string; _isEditor?: boolean };
    if (w._isEditor && w._roomId) removeEditor(w._roomId);
    removeFromRoom(roomId, ws as WebSocket);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[ramen] API http://${HOST}:${PORT}/api`);
  console.log(`[ramen] WebSocket ws://${HOST}:${PORT}/ws?room=POST_ID`);
});
