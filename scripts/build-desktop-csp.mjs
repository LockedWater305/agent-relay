#!/usr/bin/env node
/**
 * Build a desktop CSP manifest from shipped bytes, without running page code.
 * The shell's ACTUAL runScripts implementation emits its inline batches into
 * an inert DOM adapter. No duplicated wrapping/joining algorithm can drift.
 * This VM is build/test-only; neither it nor this generator ships in app.asar.
 * nav.js is trusted repository build input. node:vm is NOT a security sandbox:
 * host callbacks can expose host capabilities to modified navigation code.
 * Never use this adapter to process untrusted/user-supplied navigation code.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { CSP_MANIFEST_PATH, CSP_PAGE_NAMES, sha256, validateCspManifest } from "../desktop/csp.mjs";

function fail(message) { throw new Error(`desktop CSP: ${message}`); }

function attributes(source) {
  const result = [];
  const seen = new Set();
  let rest = source;
  while (rest.trim()) {
    const match = /^\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/.exec(rest);
    if (!match) fail("unsupported HTML attribute syntax");
    const name = match[1].toLowerCase();
    if (seen.has(name)) fail(`duplicate ${name} attribute`);
    seen.add(name);
    result.push({ name, value: match[2] ?? match[3] ?? match[4] ?? "" });
    rest = rest.slice(match[0].length);
  }
  return result;
}

/**
 * Deliberately bounded HTML tokenizer for checked-in app pages, not an HTML
 * sanitizer. Unsupported script/parser states fail the build instead of
 * guessing which bytes Chromium executes. HTML input newline normalization is
 * required for CSP hashes even when a Windows checkout uses CRLF.
 */
export function pageScripts(bytes, label = "page") {
  const html = bytes.toString("utf8").replace(/\r\n?/g, "\n");
  if (html.includes("\0")) fail(`${label}: NUL in HTML`);
  const scripts = [];
  let inBody = false;
  let at = 0;
  while ((at = html.indexOf("<", at)) !== -1) {
    if (html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      if (end === -1) fail(`${label}: unclosed comment`);
      at = end + 3;
      continue;
    }
    const tag = /^<(\/?)([a-z][a-z0-9:-]*)(\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/i.exec(html.slice(at));
    if (!tag) { at++; continue; }
    const closing = Boolean(tag[1]);
    const name = tag[2].toLowerCase();
    at += tag[0].length;
    if (name === "body") inBody = !closing;
    if (closing) continue;
    if (["template", "noscript", "xmp", "plaintext", "iframe", "noembed"].includes(name)) fail(`${label}: unsupported <${name}> parser state`);
    if (!["script", "style", "textarea", "title"].includes(name)) continue;
    const endTag = new RegExp(`</${name}\\s*>`, "ig");
    endTag.lastIndex = at;
    const end = endTag.exec(html);
    if (!end) fail(`${label}: unclosed <${name}>`);
    const textContent = html.slice(at, end.index);
    at = endTag.lastIndex;
    if (name !== "script") continue;
    // The HTML script escaped/double-escaped states need a full HTML parser.
    // No shipped script uses them; do not silently grant a speculative hash.
    if (/<!--|<\/script\b/i.test(textContent)) fail(`${label}: unsupported script escape state`);
    const attrs = attributes(tag[3] || "");
    const get = (key) => attrs.find((attr) => attr.name === key)?.value;
    const type = get("type");
    if (type && !["text/javascript", "application/javascript"].includes(type.toLowerCase())) fail(`${label}: unsupported script type ${type}`);
    if (attrs.some((attr) => attr.name.startsWith("on"))) fail(`${label}: inline script event handler`);
    const src = get("src");
    if (src !== undefined && !/^\/buzzy\/[a-z0-9-]+\.js$(?![\s\S])/.test(src)) fail(`${label}: script src must name an exact bundled /buzzy/*.js file`);
    scripts.push({ src: src ?? null, attributes: attrs, textContent, inBody });
  }
  return scripts;
}

export function shellRunScriptsSource(nav) {
  const startMarker = "  function runScripts(root) {";
  const endMarker = "  // Chrome-owned nodes must not ride in with the page.";
  const start = nav.indexOf(startMarker);
  const end = nav.indexOf(endMarker, start);
  if (start === -1 || end === -1 || nav.indexOf(startMarker, start + 1) !== -1 || nav.indexOf(endMarker, end + 1) !== -1) fail("nav.js batching boundary changed; review the generator");
  return nav.slice(start, end);
}

/** Capture output strings; appendChild never executes their text or fetches src. */
export async function shellInlineBatches(nav, scripts) {
  const emitted = [];
  const root = { querySelectorAll: () => scripts.filter((script) => script.inBody).map((script) => ({
    ...script,
    src: script.src ? `http://127.0.0.1:7331${script.src}` : "",
    remove() {},
  })) };
  const context = createContext({
    root,
    document: {
      createElement: (tag) => {
        if (tag !== "script") fail("shell emitted an unexpected element");
        return { textContent: "", setAttribute(name, value) { this[name] = value; } };
      },
      head: { appendChild(node) {
        if (node.src) node.onload();
        else emitted.push(node.textContent);
      } },
    },
  }, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const code = `${shellRunScriptsSource(nav)}\nrunScripts(root).then(() => { globalThis.finished = true; });`;
  new Script(code, { filename: "nav.js:runScripts" }).runInContext(context, { timeout: 1000 });
  if (!context.finished) fail("shell script batching did not finish synchronously with inert resources");
  return emitted;
}

export async function buildCspManifest(root) {
  const files = {};
  const read = (file) => {
    const source = readFileSync(join(root, "public", file));
    const built = readFileSync(join(root, ".output/public", file));
    if (!source.equals(built)) fail(`public/${file} differs from the built copy; rebuild before creating the manifest`);
    files[file] = sha256(source);
    return source;
  };
  const nav = read("buzzy/nav.js").toString("utf8");
  const hashes = new Set();
  const paths = new Set(["/buzzy/nav.js"]);
  for (const name of CSP_PAGE_NAMES) {
    const scripts = pageScripts(read(`buzzy/${name}.html`), name);
    for (const script of scripts) {
      if (script.src) paths.add(script.src);
      else hashes.add(sha256(script.textContent));
    }
    for (const text of await shellInlineBatches(nav, scripts)) hashes.add(sha256(text));
  }
  // chat.js and companies.js are also dynamically loaded by nav.js. Both are
  // declared by shipped pages; require that fact rather than authorizing a dir.
  for (const path of ["/buzzy/chat.js", "/buzzy/companies.js"]) {
    if (!paths.has(path)) fail(`dynamic script ${path} is no longer declared by a page; review its authority`);
  }
  for (const path of paths) read(path.slice(1));
  return validateCspManifest({
    version: 1,
    pages: [...CSP_PAGE_NAMES],
    scriptHashes: [...hashes].sort(),
    scriptPaths: [...paths].sort(),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  });
}

export async function writeCspManifest(root) {
  const manifest = await buildCspManifest(root);
  const target = join(root, CSP_MANIFEST_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = await writeCspManifest(root);
  console.log(`[desktop-csp] ${manifest.scriptHashes.length} inline hashes, ${manifest.scriptPaths.length} exact script paths; both public trees verified`);
}
