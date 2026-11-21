// Private runtime content only, never a Vite/public/checked-in asset.
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const KIT_ROUTE = "/internal/brand-kit";
const NOT_FOUND = "Not found";
const CACHE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
} as const;
const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  css: "text/css; charset=utf-8",
} as const;

type GateDeps = {
  getSessionUser(headers: Headers): Promise<{ id: string; emailVerified: boolean } | null>;
  getRoleById(userId: string): Promise<string | null>;
  isUserDisabled(userId: string): Promise<boolean>;
};

function locate(pathname: string): { relativePath: string; mime: string; maxBytes: number } | null {
  if (pathname === KIT_ROUTE || pathname === KIT_ROUTE + "/") {
    return { relativePath: "index.html", mime: "text/html; charset=utf-8", maxBytes: 512 * 1024 };
  }
  if (!pathname.startsWith(KIT_ROUTE + "/assets/")) return null;
  const file = pathname.slice((KIT_ROUTE + "/assets/").length);
  // No raw/encoded path separators, dotfiles, query-based lookup, active SVG or HTML assets.
  const match = /^([a-z0-9][a-z0-9_-]{0,74})\.(png|jpe?g|webp|css)$/.exec(file);
  if (!match) return null;
  const ext = match[2] as keyof typeof TYPES;
  return { relativePath: "assets/" + file, mime: TYPES[ext], maxBytes: ext === "css" ? 512 * 1024 : 24 * 1024 * 1024 };
}

function isAtOrInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

async function readPrivateFile(
  configured: string,
  relativePath: string,
  maxBytes: number,
  head: boolean,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const [root, app] = await Promise.all([realpath(configured), realpath(process.cwd())]);
  // Prevent selecting the app/public tree, a parent containing it, or a conventional public mount.
  if (isAtOrInside(app, root) || isAtOrInside(root, app) || root.split(sep).includes("public")) return null;
  const file = resolve(root, relativePath);
  // The route only forms fixed safe relative names; also refuse symlinks inside the private bundle.
  if (!isAtOrInside(root, file) || await realpath(file) !== file) return null;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    if (head) return new Uint8Array(0);
    // A file changing between stat and read cannot grow a bounded allocation.
    const body = new Uint8Array(stat.size);
    for (let offset = 0; offset < body.length;) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    return body;
  } finally {
    await handle.close();
  }
}

/** Every page and direct asset request revalidates the session and persistent platform role. */
export async function handleInternalBrandKit(
  request: Request,
  deps: GateDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const head = request.method === "HEAD";
  const notFound = () => new Response(head ? null : NOT_FOUND, {
    status: 404,
    headers: { ...CACHE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
  try {
    const dir = env.BEEZILLA_INTERNAL_BRAND_KIT_DIR?.trim();
    if (env.DEVBOARDS_SURFACE !== "admin" || !env.DATABASE_URL?.trim() ||
        env.VITE_AUTH_ENABLED === "false" || !dir || !isAbsolute(dir) ||
        (request.method !== "GET" && !head)) return notFound();
    const file = locate(new URL(request.url).pathname);
    if (!file) return notFound();
    // Pass only the browser session cookie, never agent Bearer, identity or proxy role headers.
    const cookie = request.headers.get("cookie");
    if (!cookie) return notFound();
    const user = await deps.getSessionUser(new Headers({ cookie }));
    if (!user?.id || user.emailVerified !== true) return notFound();
    if (await deps.isUserDisabled(user.id) || await deps.getRoleById(user.id) !== "admin") return notFound();
    const body = await readPrivateFile(dir, file.relativePath, file.maxBytes, head);
    if (!body) return notFound();
    return new Response(head ? null : body, {
      headers: { ...CACHE_HEADERS, "Content-Type": file.mime },
    });
  } catch {
    // Treat auth/database/fs errors just like denial. Do not reveal private paths or existence.
    return notFound();
  }
}
