/**
 * Tracks which rooms have at least one editor (writing app) connected via WebSocket.
 * Used so the web viewer can choose: live WS when editor is present, static API otherwise.
 */
const roomEditorCount = new Map<string, number>();

export function addEditor(roomId: string): void {
  roomEditorCount.set(roomId, (roomEditorCount.get(roomId) ?? 0) + 1);
}

export function removeEditor(roomId: string): void {
  const n = (roomEditorCount.get(roomId) ?? 1) - 1;
  if (n <= 0) roomEditorCount.delete(roomId);
  else roomEditorCount.set(roomId, n);
}

export function hasEditor(roomId: string): boolean {
  return (roomEditorCount.get(roomId) ?? 0) > 0;
}
