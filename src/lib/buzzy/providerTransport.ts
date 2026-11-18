/**
 * Personal-key destinations are checked at connection time, not just at save.
 * Node's HTTP(S) client uses only the checked lookup result and never follows
 * redirects. The URL hostname remains the HTTP Host and TLS identity. No proxy,
 * pooled connection, global-fetch fallback, or second DNS lookup is permitted.
 */
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, pipeline } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

function allowPrivate(): boolean {
  if ((process.env.BZ_ALLOW_LOCAL_AI_KEY_URL ?? "").trim() === "1") return true;
  const raw = (process.env.BZ_CHAT_BASE_URL ?? "").trim();
  try {
    const u = new URL(raw.includes("://") ? raw : "http://" + raw);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname.toLowerCase());
  } catch { return false; }
}

/** Private/reserved IPs and local names; normalize IPv6 before classification. */
export function isPrivateHost(host: string): boolean {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || /\.(localhost|local|internal|lan)$/.test(h)) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b, c] = h.split(".").map(Number) as [number, number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (v === 6) {
    // WHATWG URL canonicalizes expanded and mixed dotted/hex representations.
    let canonical: string;
    try { canonical = new URL(`https://[${h}]/`).hostname.slice(1, -1); } catch { return true; }
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16), lo = parseInt(mapped[2]!, 16);
      return isPrivateHost([hi >>> 8, hi & 255, lo >>> 8, lo & 255].join("."));
    }
    // Only native global unicast. Refuse local, multicast and transition ranges
    // whose routing can embed a second destination outside the checked address.
    return !/^[23][0-9a-f]{3}:/.test(canonical) ||
      /^2002:/.test(canonical) || /^2001:(?:0:|:|db8:)/.test(canonical) || /^3fff:/.test(canonical);
  }
  return false;
}

export function cleanBaseUrl(raw: unknown): string | null {
  return cleanUrl(raw, 300);
}

function cleanUrl(raw: unknown, maxLength: number): string | null {
  const s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!s || s.length > maxLength) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const priv = isPrivateHost(u.hostname);
  if (priv && !allowPrivate()) return null;
  if (u.protocol === "https:") return u.toString().replace(/\/+$/, "");
  if (u.protocol === "http:" && priv && allowPrivate()) return u.toString().replace(/\/+$/, "");
  return null;
}

type Resolver = (host: string) => Promise<LookupAddress[]>;
const resolve: Resolver = (host) => lookup(host, { all: true });

async function resolveWithDeadline(host: string, resolver: Resolver, timeoutMs: number): Promise<LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Personal AI provider DNS timed out.")), timeoutMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function checkedAddresses(u: URL, resolver: Resolver, timeoutMs = 5_000): Promise<LookupAddress[]> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolveWithDeadline(host, resolver, timeoutMs);
  if (!addresses.length || addresses.some((a) =>
    !isIP(a.address) || isIP(a.address) !== a.family || (!allowPrivate() && isPrivateHost(a.address)))) {
    throw new Error("Personal AI provider must resolve to an allowed address.");
  }
  return addresses.map((a) => ({ address: a.address, family: a.family }));
}

/** Preflight only; transport repeats validation and pins its own fresh result. */
export async function resolvesPublic(baseUrl: string): Promise<boolean> {
  const clean = cleanBaseUrl(baseUrl);
  if (!clean) return false;
  try { await checkedAddresses(new URL(clean), resolve); return true; } catch { return false; }
}

/** Private dependency seam for offline invariant tests; never comes from a request. */
interface TransportDependencies {
  resolve: Resolver;
  http: typeof httpRequest;
  https: typeof httpsRequest;
  /** Test-only shorter DNS deadline; never extends the production bound. */
  dnsTimeoutMs?: number;
}
const transport: TransportDependencies = { resolve, http: httpRequest, https: httpsRequest };

/** JSON POST with a Fetch-compatible streaming response, for personal keys only. */
export async function postProviderJson(
  rawUrl: string,
  apiKey: string,
  body: string,
  deps: TransportDependencies = transport,
): Promise<Response> {
  // The saved base may be 300 characters, plus the completion path.
  const clean = cleanUrl(rawUrl, 320);
  if (!clean) throw new Error("Personal AI provider URL is not allowed.");
  const u = new URL(clean);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const dnsTimeoutMs = Math.max(1, Math.min(5_000, deps.dnsTimeoutMs ?? 5_000));
  const addresses = await checkedAddresses(u, deps.resolve, dnsTimeoutMs);
  const pinnedLookup: LookupFunction = (name, options, callback) => {
    if (name !== host) { callback(new Error("Unexpected provider hostname."), ""); return; }
    const family = typeof options.family === "number" ? options.family : 0;
    const matches = addresses.filter((a) => !family || a.family === family);
    if (!matches.length) { callback(new Error("No checked address for requested family."), ""); return; }
    if (options.all) callback(null, matches.map((a) => ({ ...a })));
    else callback(null, matches[0]!.address, matches[0]!.family);
  };
  return new Promise<Response>((resolveResponse, reject) => {
    const request = u.protocol === "https:" ? deps.https : deps.http;
    const req = request(u, {
      method: "POST",
      // A new direct agent prevents reuse of a connection from another check.
      agent: false,
      lookup: pinnedLookup,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Accept-Encoding": "identity",
        Authorization: `Bearer ${apiKey}`,
      },
    }, (res) => {
      const status = res.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        res.destroy();
        reject(new Error("Personal AI provider redirects are not allowed."));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      try {
        let responseBody: Readable = res;
        const encoding = String(res.headers["content-encoding"] || "").toLowerCase().trim();
        if (encoding && encoding !== "identity") {
          const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
            : encoding === "br" ? createBrotliDecompress() : null;
          if (!decoder) throw new Error("Unsupported provider content encoding.");
          pipeline(res, decoder, (err) => { if (err) decoder.destroy(err); });
          responseBody = decoder;
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        // Response forbids bodies on these statuses; discard without buffering.
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) responseBody.resume();
        resolveResponse(new Response(empty ? null : Readable.toWeb(responseBody) as ReadableStream<Uint8Array>, { status, headers }));
      } catch (err) { res.destroy(); reject(err); }
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("Personal AI provider timed out.")));
    req.end(body);
  });
}
