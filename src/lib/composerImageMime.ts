const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jfif: "image/jpeg",
  jpe: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function composerImageMimeType(name: string, type: string): string | null {
  const normalizedType = type.toLowerCase();
  if (normalizedType !== "" && normalizedType !== "application/octet-stream") return null;

  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  const extension = name.slice(dotIndex + 1).toLowerCase();
  return Object.hasOwn(IMAGE_MIME_TYPE_BY_EXTENSION, extension) ? IMAGE_MIME_TYPE_BY_EXTENSION[extension] ?? null : null;
}

export async function normalizeComposerImageFile(file: File): Promise<File> {
  const mimeType = composerImageMimeType(file.name, file.type);
  if (mimeType === null) return file;
  const bytes = await file.slice(0, 12).arrayBuffer().catch(() => null);
  if (bytes === null) return file;
  const header = String.fromCharCode(...new Uint8Array(bytes));
  const detectedType = header.startsWith("\x89PNG\r\n\x1a\n") ? "image/png"
    : header.startsWith("\xff\xd8\xff") ? "image/jpeg"
    : header.startsWith("GIF87a") || header.startsWith("GIF89a") ? "image/gif"
    : header.startsWith("RIFF") && header.startsWith("WEBP", 8) ? "image/webp"
    : null;
  return detectedType !== mimeType
    ? file
    : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}

const HEIC_TYPES: ReadonlySet<string> = new Set(["image/heic", "image/heif"]);
const HEIC_NAME = /\.(heic|heif)$/i;
const HEIF_STILL_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "mif1", "heif"]);
const HEIF_EXCLUDED_BRANDS: ReadonlySet<string> = new Set(["msf1", "hevc", "hevx", "hevs", "avis", "avif"]);
const MAX_FTYP_INSPECT_BYTES = 4096;
/**
 * A photo is drawn at most 2048 px a side, about 1 MB as JPEG, so it uploads fast on mobile data.
 * An agent may read more: OpenAI's newest models a phone photo whole at their default, `gpt-5.5` up
 * to 6000 px and its older ones 2048 (https://developers.openai.com/api/docs/guides/images-vision),
 * Claude 2576 on its newest models and 1568 on the rest
 * (https://platform.claude.com/docs/en/build-with-claude/vision). It also keeps a 48 MP photo's
 * canvas far under iOS's 8192 by 8192 limit.
 * https://github.com/WebKit/WebKit/blob/09c9c87594bc34ed7d62db836b29091798073eb8/Source/WebCore/html/CanvasBase.cpp#L127-L128
 */
const MAX_PHOTO_SIDE = 2048;

function brandAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/**
 * Inspects an ISO-BMFF `ftyp` header and returns true only for still HEIC/HEIF images.
 * Animated sequences (e.g. `msf1`, `hevc`, `hevs`, `avis`), AVIF containers, oversized/truncated `ftyp` boxes,
 * and non-HEIF payloads (such as a PNG renamed `.heic`) return false.
 */
export function isStillHeifContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  if (brandAt(bytes, 4) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(0, false);
  let headerStart = 8;
  let end: number;
  if (size32 === 1) {
    if (bytes.byteLength < 24) return false;
    const large = view.getBigUint64(8, false);
    if (large < 24n || large > BigInt(bytes.byteLength)) return false;
    end = Number(large);
    headerStart = 16;
  } else if (size32 === 0) {
    end = bytes.byteLength;
  } else {
    if (size32 < 16 || size32 > bytes.byteLength) return false;
    end = size32;
  }
  const compatStart = headerStart + 8;
  if (end < compatStart) return false;
  const brands = [brandAt(bytes, headerStart)];
  for (let offset = compatStart; offset + 4 <= end; offset += 4) brands.push(brandAt(bytes, offset));
  if (brands.some((brand) => HEIF_EXCLUDED_BRANDS.has(brand))) return false;
  return brands.some((brand) => HEIF_STILL_BRANDS.has(brand));
}

/** Decodes an image this browser can draw and encodes it as JPEG; null when the canvas refuses. */
async function canvasJpeg(image: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    if (element.naturalWidth <= 0 || element.naturalHeight <= 0) return null;

    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(element.naturalWidth, element.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(element.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(element.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob !== null && blob.size > 0 && blob.type === "image/jpeg" ? blob : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const JPEG_START = 0xd8;
const JPEG_END = 0xd9;
const JPEG_SCAN = 0xda;
const JPEG_APP0 = 0xe0;
const JPEG_EXIF = 0xe1;
const JPEG_APP2 = 0xe2;
const JPEG_APP15 = 0xef;
const JPEG_COMMENT = 0xfe;
const JFIF_HEADER = [0x4a, 0x46, 0x49, 0x46, 0] as const;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0] as const;
const ICC_HEADER = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0] as const;
const EXIF_ORIENTATION = 0x0112;

function startsWith(body: Uint8Array, header: readonly number[]): boolean {
  return body.length >= header.length && header.every((byte, index) => body[index] === byte);
}

function hasJpegStart(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === JPEG_START;
}

/** A marker with no length after it: TEM and RST0 to RST7, https://www.w3.org/Graphics/JPEG/itu-t81.pdf table B.1 */
function standalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** The Exif orientation in an APP1 segment's body, or null; IFD0 layout: https://www.cipa.jp/std/documents/e/DC-008-2012_E.pdf */
function exifOrientation(body: Uint8Array): number | null {
  if (body.length < 14 || !startsWith(body, EXIF_HEADER)) return null;

  const tiff = new DataView(body.buffer, body.byteOffset + EXIF_HEADER.length, body.length - EXIF_HEADER.length);
  const byteOrder = tiff.getUint16(0);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;
  const little = byteOrder === 0x4949;
  if (tiff.getUint16(2, little) !== 42) return null;
  const ifd = tiff.getUint32(4, little);
  if (ifd < 8 || ifd % 2 !== 0 || ifd + 2 > tiff.byteLength) return null;

  const end = ifd + 2 + tiff.getUint16(ifd, little) * 12;
  if (end + 4 > tiff.byteLength) return null;
  let orientation: number | null = null;
  for (let entry = ifd + 2; entry < end; entry += 12) {
    if (tiff.getUint16(entry, little) !== EXIF_ORIENTATION) continue;
    if (orientation !== null || tiff.getUint16(entry + 2, little) !== 3 || tiff.getUint32(entry + 4, little) !== 1) return null;
    const value = tiff.getUint16(entry + 8, little);
    if (value < 1 || value > 8) return null;
    orientation = value;
  }

  return orientation;
}

/** An APP1 segment whose Exif holds the orientation alone. */
function orientationSegment(orientation: number): Uint8Array<ArrayBuffer> {
  const ifd = [0, 1, EXIF_ORIENTATION >> 8, EXIF_ORIENTATION & 0xff, 0, 3, 0, 0, 0, 1, orientation >> 8, orientation & 0xff, 0, 0, 0, 0, 0, 0];
  const body = [...EXIF_HEADER, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, ...ifd];
  return new Uint8Array([0xff, JPEG_EXIF, 0, body.length + 2, ...body]);
}

/**
 * Where the entropy-coded data after a scan header ends: at the first 0xFF that, past any fill
 * bytes, opens neither a stuffed byte nor an RST marker.
 */
function scanEnd(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let next = offset + 1;
    while (bytes[next] === 0xff) next += 1;

    if (next >= bytes.length) return bytes.length;
    if (bytes[next] !== 0 && !standalone(bytes[next]!)) return offset;

    offset = next + 1;
  }

  return bytes.length;
}

/**
 * Keep coding segments, JFIF, ICC and a valid Exif orientation from the JPEG's first image.
 * Other application metadata, comments, and anything after that image's end go too. Stray bytes
 * between segments are skipped, as libjpeg does, so they cannot hide a segment after them
 * (https://github.com/libjpeg-turbo/libjpeg-turbo/blob/4e151a4ad91001b3aa8c2ece2205c15f487ce320/src/jdmarker.c#L890-L925).
 * If the marker walk cannot reach the end of an image, return the unmodified input.
 */
export async function withoutJpegMetadata<T extends Blob>(file: T): Promise<T | Blob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasJpegStart(bytes)) return file;

  const kept: Uint8Array<ArrayBuffer>[] = [bytes.subarray(0, 2)];
  let hasFrame = false;
  let hasScan = false;
  let exifIndex: number | undefined;
  let orientation: number | null = null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    const marker = bytes[offset + 1]!;
    if (bytes[offset] !== 0xff || marker === 0xff) {
      offset += 1;
      continue;
    }

    if (marker === JPEG_END) {
      if (!hasScan) return file;
      if (exifIndex !== undefined && orientation !== null) kept.splice(exifIndex, 0, orientationSegment(orientation));
      return new Blob([...kept, bytes.subarray(offset, offset + 2)], { type: file.type });
    }
    if (marker === JPEG_START) return file;

    if (standalone(marker)) {
      kept.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    if (offset + 4 > bytes.length) return file;

    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) return file;
    const body = bytes.subarray(offset + 4, end);
    if (marker === JPEG_EXIF && startsWith(body, EXIF_HEADER)) {
      orientation = exifIndex === undefined ? exifOrientation(body) : null;
      exifIndex ??= kept.length;
    }

    const isApplication = marker >= JPEG_APP0 && marker <= JPEG_APP15;
    if ((!isApplication && marker !== JPEG_COMMENT)
      || (marker === JPEG_APP0 && startsWith(body, JFIF_HEADER))
      || (marker === JPEG_APP2 && startsWith(body, ICC_HEADER))) kept.push(bytes.subarray(offset, end));

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) hasFrame = true;
    offset = end;
    if (marker === JPEG_SCAN) {
      if (!hasFrame) return file;
      offset = scanEnd(bytes, end);
      if (offset === end) return file;
      kept.push(bytes.subarray(end, offset));
      hasScan = true;
    }
  }

  return file;
}

/**
 * A photo as a JPEG of at most `MAX_PHOTO_SIDE` a side: a still HEIC or HEIF one always, since the
 * agents read only PNG, JPEG, GIF and WebP
 * (https://platform.claude.com/docs/en/build-with-claude/vision), and a JPEG one too, which drops
 * its camera metadata; a JPEG this browser cannot redraw is stripped if its markers can be parsed.
 * Any other file (a screenshot's PNG, an animated HEIC sequence, a file that is not HEIF inside), or a
 * HEIC one this browser cannot decode, as it is.
 */
export async function uploadableImage<T extends Blob>(file: T, toJpeg: (image: Blob) => Promise<Blob | null> = canvasJpeg): Promise<T | File> {
  const name = file instanceof File ? file.name : "";
  const lastModified = file instanceof File ? file.lastModified : Date.now();
  const normalizedType = (composerImageMimeType(name, file.type) ?? file.type).toLowerCase().split(";", 1)[0]!.trim();
  const heicCandidate = HEIC_TYPES.has(normalizedType)
    || ((normalizedType === "" || normalizedType === "application/octet-stream") && HEIC_NAME.test(name));
  if (!heicCandidate && normalizedType !== "image/jpeg") return file;

  if (heicCandidate) {
    const header = new Uint8Array(await file.slice(0, MAX_FTYP_INSPECT_BYTES).arrayBuffer());
    if (!isStillHeifContainer(header)) return file;
  } else {
    const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    if (!hasJpegStart(header)) return file;
  }

  const jpeg = await toJpeg(file).catch(() => null);
  if (jpeg === null && heicCandidate) return file;

  if (jpeg === null) {
    const stripped = await withoutJpegMetadata(file);
    return stripped === file ? file : new File([stripped], name, { type: normalizedType, lastModified });
  }

  const base = name.replace(/\.(heic|heif|jpe?g|jpe|jfif)$/i, "") || "photo";
  return new File([jpeg], `${base}.jpg`, { type: "image/jpeg", lastModified });
}
