/** The addon's caps: decoded file bytes and pixels. */
export interface PictureLimits { readonly sizeLimit: number; readonly pixelLimit: number; readonly sixelSizeLimit?: number }

export const ITERM_PICTURE_COMMANDS = ["File=", "MultipartFile=", "FilePart=", "FileEnd"] as const;
export const ITERM_ARGS_ROOM = 65536;

export const decodedLength = (base64: string): number =>
  Math.floor((base64.length - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0)) * 3 / 4);
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;
export const validBase64 = (base64: string): boolean =>
  base64.length > 0 && base64.length % 4 !== 1 && (!base64.endsWith("=") || base64.length % 4 === 0)
  && /^[A-Za-z0-9+/]*={0,2}$/.test(base64);

export const sizeOf = (args: string): number | null => {
  const match = /(?:^|;)size=(\d+)/.exec(args);
  return match ? Number(match[1]) : null;
};

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  // Each slice is a multiple of three bytes so only the last slice is padded.
  const slice = 3 * 0x2aaa;
  for (let i = 0; i < bytes.length; i += slice) out += btoa(String.fromCharCode(...bytes.subarray(i, i + slice)));
  return out;
}

export function itermFile(data: string): { readonly args: string; readonly base64: string } | null {
  const colon = data.indexOf(":");
  return colon < 0 || colon > ITERM_ARGS_ROOM ? null : { args: data.slice("File=".length, colon), base64: data.slice(colon + 1) };
}

export function itermMultipart<T>(picture: (args: string, base64: string) => T, limits: () => PictureLimits) {
  let pending: { readonly args: string; readonly parts: string[]; readonly recent: string[]; length: number } | null = null;
  return {
    active: () => pending !== null,
    reset: () => { pending = null; },
    handle(data: string): T | null {
      if (data.startsWith("MultipartFile=")) {
        const args = data.slice("MultipartFile=".length);
        const size = sizeOf(args);
        pending = args.length > ITERM_ARGS_ROOM || (size !== null && size > limits().sizeLimit)
          ? null : { args, parts: [], recent: [], length: 0 };
      } else if (data.startsWith("FilePart=") && pending) {
        const part = data.slice("FilePart=".length);
        if (part.length === 0) return null;
        pending.length += part.length;
        if (pending.length > base64Length(limits().sizeLimit)) pending = null;
        else {
          pending.recent.push(part);
          // With tiny parts, keep the number of strings proportional to the bytes, not the writes.
          if (pending.recent.length === 1024) pending.parts.push(pending.recent.splice(0).join(""));
        }
      } else if (data.startsWith("FileEnd")) {
        const done = pending;
        pending = null;
        if (done) return picture(done.args, done.parts.join("") + done.recent.join(""));
      }
      return null;
    },
  };
}
