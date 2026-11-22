/**
 * The bytes a device signs to register its key for its own sign-in (account service S2-19, device table P18):
 * `ovis-device-register/1`, then the account, the key, the challenge id and the challenge, each as a 4-byte
 * big-endian length and its UTF-8 bytes. Must stay byte-for-byte equal to the service's.
 */
const DEVICE_REGISTER_PREFIX = "ovis-device-register/1";

export function registerSigningBytes(account: string, key: string, challengeId: string, challenge: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts = [account, key, challengeId, challenge].map((part) => encoder.encode(part));
  const prefix = encoder.encode(DEVICE_REGISTER_PREFIX);
  const bytes = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  bytes.set(prefix);
  const view = new DataView(bytes.buffer);
  let offset = prefix.length;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}
