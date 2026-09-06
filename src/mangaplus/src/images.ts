/**
 * Fetching and decrypting a MangaPlus page image.
 *
 * Why an extension that publishes external links wants this at all: the page
 * count from `manga_viewer` is a claim, and a claim is what put a dead chapter
 * on MangaDex in the first place. Before a chapter is uploaded, one of its
 * pages is actually retrieved and checked to be an image. That turns "MangaPlus
 * says there are 71 pages" into "page one exists and is a JPEG", which is the
 * property a reader following the external link depends on.
 *
 * The scheme is the one `mloader` (github.com/hurlenko/mloader, GPL-3.0) uses,
 * re-derived here rather than copied and re-verified against the live API:
 * request `manga_viewer` with `split` and `img_quality`, then, when a page
 * carries an `encryptionKey`, XOR the bytes with that key repeating. The web
 * `high` quality currently serves pages with no key at all — they arrive as
 * ordinary JPEGs — so `decryptImage` is a no-op there and is kept because the
 * field is still in the schema and still set on other qualities.
 */

/** Hex string -> bytes; null when it isn't clean hex. */
function hexToBytes(hex: string): Uint8Array | null {
  const trimmed = hex.trim();
  if (trimmed.length === 0 || trimmed.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null;

  const bytes = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Undo MangaPlus' page encryption: a repeating-key XOR over the whole body.
 *
 * An absent or malformed key means the page was never encrypted, so the bytes
 * are returned untouched — that is the normal case for the quality this
 * extension requests, not an error.
 */
export function decryptImage(data: Uint8Array, encryptionKey?: string): Uint8Array {
  if (!encryptionKey) return data;
  const key = hexToBytes(encryptionKey);
  if (key === null || key.length === 0) return data;

  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  return out;
}

/**
 * Does this look like an image MangaPlus would serve?
 *
 * Magic bytes only. The point is to catch a body that is an error page, an
 * expired-link response or an empty file — not to validate the image, which
 * would mean decoding it for no gain.
 */
export function looksLikeImage(data: Uint8Array): boolean {
  if (data.length < 12) return false;

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return true;
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return true;
  }
  return false;
}
