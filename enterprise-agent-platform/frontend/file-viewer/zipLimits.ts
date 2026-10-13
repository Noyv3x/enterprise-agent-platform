// Archive bounds checked from the ZIP central directory alone, before any library inflates a byte.
// The directory's declared sizes are what a decompression bomb lies about only by being larger than reality
// (a library that inflates is bounded by what the entry header claims), so over-limit declarations are refused.
export const MAX_ENTRIES = 2048;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_XML_PART_BYTES = 8 * 1024 * 1024;
export const MAX_PART_BYTES = 32 * 1024 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const ZIP64_MARK = 0xffffffff;

/** True when the archive is a well-formed ZIP within the limits; false for anything else (zip64, truncated, over-limit). */
export function withinZipLimits(buffer: ArrayBuffer): boolean {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let at = buffer.byteLength - 22; at >= Math.max(0, buffer.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return false;
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const start = view.getUint32(eocd + 16, true);
  if (count === 0xffff || size === ZIP64_MARK || start === ZIP64_MARK || count > MAX_ENTRIES) return false;
  if (start + size > buffer.byteLength) return false;
  const decoder = new TextDecoder();
  let at = start;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > start + size || view.getUint32(at, true) !== CENTRAL) return false;
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (uncompressed === ZIP64_MARK || at + 46 + nameLength > start + size) return false;
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)).toLowerCase();
    const xml = name.endsWith(".xml") || name.endsWith(".rels");
    if (uncompressed > (xml ? MAX_XML_PART_BYTES : MAX_PART_BYTES)) return false;
    total += uncompressed;
    if (total > MAX_TOTAL_BYTES) return false;
    at += 46 + nameLength + extraLength + commentLength;
  }
  return true;
}
