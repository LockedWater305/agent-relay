/** Desktop-only script policy. No Electron, renderer evaluation, or network I/O. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAppPage, runtimeOrigin, UI_PAGE_NAMES } from "./security.mjs";

export const CSP_MANIFEST_PATH = ".output/desktop-csp.json";
export const CSP_PAGE_NAMES = Object.freeze(UI_PAGE_NAMES.filter((name) => name !== "index").sort());
const SHA256 = /^sha256-[A-Za-z0-9+/]{43}=$/;
const SCRIPT_PATH = /^\/buzzy\/[a-z0-9-]+\.js$(?![\s\S])/;
const isHash = (value) => typeof value === "string" && value.length === 51 && SHA256.test(value);
export const sha256 = (bytes) => `sha256-${createHash("sha256").update(bytes).digest("base64")}`;

function invalid(reason) {
  throw new Error(`The desktop script policy is incomplete or stale (${reason}). Rebuild with npm run build, or reinstall BeeZilla.`);
}

/** A manifest is build output, not permission to add arbitrary CSP expressions. */
export function validateCspManifest(manifest) {
  if (!manifest || manifest.version !== 1) invalid("manifest version");
  if (!Array.isArray(manifest.pages) || JSON.stringify(manifest.pages) !== JSON.stringify(CSP_PAGE_NAMES)) invalid("page list");
  const hashes = manifest.scriptHashes;
  const paths = manifest.scriptPaths;
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 256 || hashes.some((hash) => !isHash(hash))) invalid("script hashes");
  if (!Array.isArray(paths) || !paths.length || paths.length > 64 || paths.some((path) => typeof path !== "string" || !SCRIPT_PATH.test(path)) || !paths.includes("/buzzy/nav.js")) invalid("script paths");
  for (const list of [hashes, paths]) {
    if (JSON.stringify([...new Set(list)].sort()) !== JSON.stringify(list)) invalid("noncanonical manifest");
  }
  const files = manifest.files;
  const expected = [...CSP_PAGE_NAMES.map((name) => `buzzy/${name}.html`), ...paths.map((path) => path.slice(1))].sort();
  if (!files || typeof files !== "object" || Array.isArray(files) || JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(expected)) invalid("source files");
  if (Object.values(files).some((hash) => !isHash(hash))) invalid("source digests");
  return manifest;
}

/**
 * Both trees can serve HTML: the page handler prefers public, whereas Nitro's
 * static handler can answer .html aliases from .output/public. Never authorize
 * hashes for one tree while serving different bytes from the other.
 */
export function loadCspManifest(root) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, CSP_MANIFEST_PATH), "utf8")); }
  catch { invalid("missing or unreadable manifest"); }
  validateCspManifest(manifest);
  for (const [file, expected] of Object.entries(manifest.files)) {
    for (const tree of ["public", ".output/public"]) {
      let bytes;
      try { bytes = readFileSync(join(root, tree, file)); }
      catch { invalid(`${tree}/${file} missing`); }
      if (sha256(bytes) !== expected) invalid(`${tree}/${file} changed`);
    }
  }
  return manifest;
}

export function desktopContentSecurityPolicy(manifest, runtime) {
  const base = runtimeOrigin(runtime);
  // Exact bundled JS paths, not 'self', a whole directory, https:, or *. Uploaded
  // files/API responses can never become executable merely by sharing the origin.
  const scripts = [...manifest.scriptPaths.map((path) => `${base}${path}`), ...manifest.scriptHashes.map((hash) => `'${hash}'`)];
  return [
    `script-src ${scripts.join(" ")}`,
    "script-src-attr 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Deliberately no default-src/style-src/connect-src rollout here. Existing
 * inline/dynamic CSS, images, audio and fonts retain their behavior; JS does not
 * get unsafe-inline or unsafe-eval. This is not a claim of complete XSS defense.
 */
export function createDesktopCsp({ manifest, getRuntime, getContents }) {
  validateCspManifest(manifest);
  const policyManifest = { scriptPaths: [...manifest.scriptPaths], scriptHashes: [...manifest.scriptHashes] };
  const pending = new Map();
  // Only origins proven by an authenticated app-document request enter this
  // set. A retired product document must be canceled, not accepted without CSP
  // during the supervisor's null-runtime gap. Never classify arbitrary ports.
  const knownOrigins = new Set();
  const registeredContents = (details) => {
    const wc = getContents().find((item) => !item.isDestroyed() && item.id === details.webContentsId);
    return wc && (!details.webContents || details.webContents === wc) ? wc : null;
  };
  const knownPage = (url) => [...knownOrigins].some((origin) => isAppPage(url, origin));
  return {
    /** Called with the actual runtimeAuth result, before sending its headers. */
    authorizeRequest(details, authorization) {
      if (details.resourceType !== "mainFrame") return authorization;
      const wc = registeredContents(details);
      if (!wc) return authorization;
      const runtime = getRuntime();
      const base = runtime ? runtimeOrigin(runtime) : null;
      const currentPage = base && isAppPage(details.url, base);
      if (!currentPage && !knownPage(details.url)) return authorization;
      pending.delete(details.id);
      const bearer = Object.entries(authorization.requestHeaders ?? {})
        .find(([name]) => name.toLowerCase() === "authorization")?.[1];
      if (!currentPage || authorization.cancel || !Number.isInteger(details.id) ||
          typeof runtime.token !== "string" || !runtime.token || bearer !== `Bearer ${runtime.token}`) {
        return { cancel: true };
      }
      knownOrigins.add(base);
      // Do not evict existing records and accidentally forget stale responses.
      // There should only be a handful of product document requests in flight.
      if (pending.size >= 128) return { cancel: true };
      pending.set(details.id, { wc, url: details.url, base, token: runtime.token });
      return authorization;
    },
    finished(details) { pending.delete(details.id); },
    headers(details) {
      if (details.resourceType !== "mainFrame") return {};
      const wc = registeredContents(details);
      if (!wc) return {};
      const runtime = getRuntime();
      const base = runtime ? runtimeOrigin(runtime) : null;
      const currentPage = base && isAppPage(details.url, base);
      if (!currentPage && !knownPage(details.url)) return {};
      const approved = pending.get(details.id);
      // Authorization is request- and generation-bound, not merely port-bound.
      // A stopped/restarted runtime (even reusing the port) cannot complete an
      // old product navigation without policy, or inherit its authorization.
      if (!currentPage || !approved || approved.wc !== wc || approved.url !== details.url ||
          approved.base !== base || approved.token !== runtime.token) return { cancel: true };
      // Chromium's resourceType identifies the main-document response. The
      // optional requesting frame can be old/null during navigation; using it
      // as an extra gate here could deliver a valid new document without CSP.
      const responseHeaders = { ...details.responseHeaders };
      const key = Object.keys(responseHeaders).find((name) => name.toLowerCase() === "content-security-policy") || "Content-Security-Policy";
      const existing = responseHeaders[key];
      // Multiple enforced policies intersect. Append; never overwrite/relax a
      // server policy, and leave Report-Only and every other header untouched.
      responseHeaders[key] = [
        ...(Array.isArray(existing) ? existing : existing === undefined ? [] : [existing]),
        desktopContentSecurityPolicy(policyManifest, runtime),
      ];
      return { responseHeaders };
    },
  };
}
