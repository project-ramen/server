import * as Y from "yjs";

const docs = new Map<string, Y.Doc>();

function getOrCreateDoc(roomId: string): Y.Doc {
  let doc = docs.get(roomId);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(roomId, doc);
  }
  return doc;
}

export function getDoc(roomId: string): Y.Doc {
  return getOrCreateDoc(roomId);
}

export function getRoomIds(): string[] {
  return Array.from(docs.keys());
}
