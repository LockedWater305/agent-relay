/** The HTML pages owned by the BeeZilla page handler, not arbitrary assets. */
export const BUZZY_PAGE_NAMES = Object.freeze([
  "talk", "memory", "remember", "experts", "library", "profile", "landing",
  "login", "recipes", "wallet", "upload", "graph", "capabilities", "project",
  "sketch", "studio", "settings",
] as const);

const pages = new Set<string>(BUZZY_PAGE_NAMES);

/**
 * Canonicalize known HTML aliases only. Input is an origin-form request target
 * (pathname + raw query), never a hostname or a user-provided redirect target.
 * Keep the query byte-for-byte, including duplicate keys and a lone '?'. A
 * fragment is not sent in HTTP; omitting one from Location lets browsers keep it.
 */
export function htmlAliasLocation(target: string, method: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (/[\u0000-\u0020\u007f#]/.test(target)) return null;
  const queryAt = target.indexOf("?");
  let pathname = queryAt < 0 ? target : target.slice(0, queryAt);
  // Nitro's pinned static handler decodes once (but protects encoded '/').
  // Cover encoded letters/dots too, without turning encoded separators or
  // decoded dot segments into a broader path. Never decode the query.
  if (/%(?:2f|5c)/i.test(pathname)) return null;
  try { pathname = decodeURIComponent(pathname); } catch { return null; }
  const match = /^\/buzzy\/([a-z-]+)\.html\/?$/.exec(pathname);
  if (!match || (match[1] !== "index" && !pages.has(match[1]))) return null;
  const name = match[1] === "index" ? "talk" : match[1];
  return `/buzzy/${name}${queryAt < 0 ? "" : target.slice(queryAt)}`;
}
