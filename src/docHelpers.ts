/**
 * Helpers for document ids and slug <-> numeric id (web API compatibility).
 */
export const POST_PREFIX = "post:";
export const COMMENT_PREFIX = "comment:";
export const REVISION_PREFIX = "revision:";
export const ROOM_PREFIX = "room:";

export function postId(slug: string): string {
  return POST_PREFIX + slug;
}

export function slugFromPostId(id: string): string {
  return id.startsWith(POST_PREFIX) ? id.slice(POST_PREFIX.length) : id;
}

/** Deterministic numeric id for a slug so web (post_id) keeps working. */
export function slugToNumericId(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) - h + slug.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

export function commentId(uuid: string): string {
  return COMMENT_PREFIX + uuid;
}

export function revisionId(postSlug: string, suffix: string): string {
  return `${REVISION_PREFIX}${postSlug}:${suffix}`;
}

export function roomId(slug: string): string {
  return ROOM_PREFIX + slug;
}
