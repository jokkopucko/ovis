/** Proof of key possession only. Authorization (or disclosure of receipts) is decided by the caller. */
export async function verifyRelayProof(key: string, proof: { nonce: Uint8Array; signature: string; serverId: string }): Promise<boolean> {
  if (proof.nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) return false;
  const signed = Buffer.from(proof.signature, "base64url");
  if (signed.length !== 64 || signed.toString("base64url") !== proof.signature) return false;
  const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), proof.nonce, Buffer.from(proof.serverId)]);
  try {
    const publicKey = await crypto.subtle.importKey("spki", Buffer.from(key, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signed, message);
  } catch (error) {
    if (error instanceof DOMException) return false;
    throw error;
  }
}
