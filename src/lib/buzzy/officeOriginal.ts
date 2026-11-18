import { createHash } from "node:crypto";

const OFFICE_TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
type OfficeFormat = keyof typeof OFFICE_TYPES;

/** Exact original formats, not the shared `officedocument` substring. */
export function originalOfficeFormat(contentType: unknown): OfficeFormat | null {
  if (typeof contentType !== "string") return null;
  const type = contentType.trim().toLowerCase();
  return type === OFFICE_TYPES.xlsx ? "xlsx" : type === OFFICE_TYPES.pptx ? "pptx" : null;
}

/**
 * Delivery identity only, not an Office-file validator or an approval token.
 * A retained card must not silently retrieve a replacement job artifact.
 * Do not normalize the original filename or silently repair malformed bytes.
 */
export function officeOriginalMetadata(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const artifact = raw as Record<string, unknown>;
  const format = originalOfficeFormat(artifact.contentType);
  const filename = artifact.filename;
  const encoded = artifact.bytesB64;
  if (!format || typeof filename !== "string" || !filename ||
      /[\\/\u0000-\u001f\u007f-\u009f]/u.test(filename) ||
      !filename.toLowerCase().endsWith(`.${format}`)) return null;
  // encodeURIComponent must never replace or throw on an invalid UTF-16 name.
  for (let i = 0; i < filename.length; i++) {
    const unit = filename.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = filename.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
  }
  if (typeof encoded !== "string" || !encoded ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) return null;
  const contentType = OFFICE_TYPES[format];
  const key = createHash("sha256")
    .update("beezilla-office-original-v1\0")
    .update(JSON.stringify([filename, contentType]))
    .update("\0")
    .update(bytes)
    .digest("hex");
  return { format, filename, contentType, bytes, key };
}

export function officeOriginalDisposition(filename: string): string {
  // ASCII fallback for older clients; filename* carries the exact Unicode name.
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g,
    ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
