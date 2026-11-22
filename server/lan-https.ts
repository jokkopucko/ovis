/**
 * An opt-in HTTPS listener for clients on the same network (#1525): a phone on the PC's Wi-Fi reaches
 * it directly instead of through a tunnel, without the token or a device cookie crossing the LAN in
 * the clear. Nothing here runs unless OVIS_LAN_HTTPS_PORT is set.
 *
 * It binds the PC's private IPv4 interface addresses (never 0.0.0.0 unless OVIS_LAN_HTTPS_HOST says
 * so) and answers private IPv4 peers only. Who gets in is narrower than on the main listener
 * (dispatch.ts `lanHttps`): the token or a paired device, never "this computer" or an open install.
 * Its certificate is the operator's own (a local CA's, OVIS_LAN_HTTPS_CERT/KEY) or a self-signed one
 * made here and kept in the state dir.
 */
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const EXTENDED_KEY_USAGE_OID = "2.5.29.37";
const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";
const SUBJECT_ALT_NAME_OID = "2.5.29.17";

export interface LanHttpsConfig {
  readonly port: number;
  /** one address to bind instead of every private interface address; `0.0.0.0` only when written */
  readonly host?: string;
  readonly certFile?: string;
  readonly keyFile?: string;
}

export interface LanHttpsCertificate {
  readonly cert: string;
  readonly key: string;
  /** colon-separated uppercase hex, as browsers show it */
  readonly sha256: string;
}

export function lanHttpsConfig(env: Record<string, string | undefined>): LanHttpsConfig | { error: string } | null {
  const portText = env["OVIS_LAN_HTTPS_PORT"]?.trim() ?? "";
  if (portText === "") return null;
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 65535)) return { error: `OVIS_LAN_HTTPS_PORT must be a port from 1 to 65535, not "${portText}"` };
  const host = env["OVIS_LAN_HTTPS_HOST"]?.trim() || undefined;
  if (host !== undefined && isIP(host) !== 4) return { error: `OVIS_LAN_HTTPS_HOST must be an IPv4 address, not "${host}"` };
  const certFile = env["OVIS_LAN_HTTPS_CERT"]?.trim() || undefined;
  const keyFile = env["OVIS_LAN_HTTPS_KEY"]?.trim() || undefined;
  if (certFile !== undefined && keyFile === undefined) return { error: "OVIS_LAN_HTTPS_CERT needs OVIS_LAN_HTTPS_KEY beside it" };
  if (keyFile !== undefined && certFile === undefined) return { error: "OVIS_LAN_HTTPS_KEY needs OVIS_LAN_HTTPS_CERT beside it" };
  return { port, ...(host ? { host } : {}), ...(certFile && keyFile ? { certFile, keyFile } : {}) };
}

const privateIpv4 = new BlockList();
for (const [network, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16]] as const) privateIpv4.addSubnet(network, prefix, "ipv4");

/** A peer on a private IPv4 network (RFC 1918 or link-local); never loopback, a tailnet or CGNAT address, a public or an IPv6 one. */
export function privateLanPeer(address: string | null | undefined): boolean {
  const plain = address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address ?? "";
  return isIP(plain) === 4 && privateIpv4.check(plain, "ipv4");
}

/** This PC's private IPv4 interface addresses, the ones the listener binds by default. */
export function privateLanAddresses(): string[] {
  const found = Object.values(networkInterfaces()).flatMap((list) => list ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal && privateLanPeer(entry.address)).map((entry) => entry.address);
  return [...new Set(found)];
}

/**
 * The certificate to serve: the operator's files as they are, or the self-signed one kept in
 * `<stateDir>/lan-https`, made again when it does not load, has run out or does not name one of
 * `addresses` (the PC moved to another network).
 */
export function lanHttpsCertificate(stateDir: string, config: LanHttpsConfig, addresses: readonly string[]): LanHttpsCertificate {
  if (config.certFile !== undefined && config.keyFile !== undefined) return loaded(readFileSync(config.certFile, "utf8"), readFileSync(config.keyFile, "utf8"));
  const dir = join(stateDir, "lan-https");
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  try {
    const kept = loaded(readFileSync(certPath, "utf8"), readFileSync(keyPath, "utf8"));
    const x509 = new X509Certificate(kept.cert);
    // one made while the clock ran ahead is refused by clients until then
    if (Date.parse(x509.validFrom) <= Date.now() && Date.parse(x509.validTo) > Date.now() && addresses.every((address) => x509.checkIP(address) !== undefined)) {
      // a restored or copied state dir may have widened them
      chmodSync(dir, 0o700);
      chmodSync(keyPath, 0o600);
      return kept;
    }
  } catch {
  }
  const made = selfSignedCertificate(addresses);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(keyPath, made.key, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeFileSync(certPath, made.cert);
  return loaded(made.cert, made.key);
}

/** Both PEMs parse and belong together; the fingerprint is the certificate's. */
function loaded(cert: string, key: string): LanHttpsCertificate {
  const x509 = new X509Certificate(cert);
  if (!x509.checkPrivateKey(createPrivateKey(key))) throw new Error("the certificate and the key do not belong together");
  return { cert, key, sha256: x509.fingerprint256 };
}

/** Apple's limit for a TLS server certificate's lifetime; a longer one is refused even where trusted by hand. */
const VALID_DAYS = 825;

/** A self-signed EC P-256 certificate for `localhost`, 127.0.0.1 and `addresses`, built here so no openssl is needed. */
export function selfSignedCertificate(addresses: readonly string[], now = new Date()): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("Ovis LAN")))));
  // positive, and minimal in DER: no leading zero byte for a parser to refuse
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const ips = [...new Set(["127.0.0.1", ...addresses])].map((address) => tlv(0x87, Buffer.from(address.split(".").map(Number))));
  // no keyUsage: one without keyCertSign stops a verifier trusting the certificate as its own issuer, the way a pinned or installed self-signed one is trusted
  const extensions = seq(
    seq(oid(EXTENDED_KEY_USAGE_OID), tlv(0x04, seq(oid(SERVER_AUTH_OID)))),
    seq(oid(SUBJECT_ALT_NAME_OID), tlv(0x04, seq(tlv(0x82, Buffer.from("localhost")), ...ips))),
  );
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name,
    seq(derTime(new Date(now.getTime() - 60_000)), derTime(new Date(now.getTime() - 60_000 + VALID_DAYS * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { cert: pem("CERTIFICATE", der), key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

function tlv(tag: number, value: Buffer): Buffer {
  const length = value.length < 0x80 ? Buffer.from([value.length]) : value.length < 0x100 ? Buffer.from([0x81, value.length]) : Buffer.from([0x82, value.length >> 8, value.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, value]);
}
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) groups.unshift((value & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime (YYMMDDHHMMSSZ) through 2049, GeneralizedTime (YYYYMMDDHHMMSSZ) from 2050, as RFC 5280 says. */
function derTime(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
