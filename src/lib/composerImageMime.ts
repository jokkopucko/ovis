const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
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
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

export function normalizeComposerImageFile(file: File): File {
  const mimeType = composerImageMimeType(file.name, file.type);
  return mimeType === null
    ? file
    : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}
