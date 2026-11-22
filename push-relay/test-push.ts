/**
 * One real push through a deployed relay, to check the whole path after a deploy: registration,
 * the relay's request to APNs (which takes HTTP/2 only, so only a real APNs shows it works) or to
 * FCM (after signing in to Google with the relay's service account, which only Google can check),
 * and the phone. The keys are made here, not the app's, so the phone cannot decrypt it and shows
 * the fallback line ("herdr needs you").
 *
 * An FCM token FCM calls invalid (a made-up one) is answered 410, which only comes once the relay
 * has signed in to Google.
 */

import webpush from "web-push";

const fcm = process.argv[2] === "fcm";
const [token, ...rest] = process.argv.slice(fcm ? 3 : 2);
const environment = fcm ? undefined : rest.shift() ?? "production";
const relay = rest[0] ?? "https://push.ovis.sh";
if (!token || (environment !== undefined && environment !== "production" && environment !== "sandbox")) {
  console.error("usage: bun push-relay/test-push.ts <APNs device token, hex> [production|sandbox] [relay origin]");
  console.error("       bun push-relay/test-push.ts fcm <FCM registration token> [relay origin]");
  process.exit(2);
}
const service = fcm ? "FCM" : "APNs";

const pc = webpush.generateVAPIDKeys();
const registered = await fetch(`${relay}/v1/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(fcm ? { service: "fcm", token, vapid_key: pc.publicKey } : { token, environment, vapid_key: pc.publicKey }),
});
console.log(`register: ${registered.status}`);
if (registered.status !== 201) process.exit(1);
const { endpoint } = (await registered.json()) as { endpoint: string };

const device = { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") };
const details = webpush.generateRequestDetails({ endpoint, keys: device }, JSON.stringify({ title: "Ovis", body: "relay test" }), {
  vapidDetails: { subject: "https://github.com/devswha/ovis", publicKey: pc.publicKey, privateKey: pc.privateKey },
  TTL: 60, urgency: "high", contentEncoding: "aes128gcm",
});
const headers: Record<string, string> = {};
for (const [name, value] of Object.entries(details.headers)) headers[name] = String(value);
const pushed = await fetch(details.endpoint, { method: "POST", headers, body: new Uint8Array(details.body) });
const notes: Record<number, string> = {
  201: `${service} took it: the phone should show "herdr needs you"`,
  410: `${service} called the token gone or invalid${fcm ? ", after the relay signed in to Google" : ""}`,
};
console.log(`push: ${pushed.status}${notes[pushed.status] ? ` (${notes[pushed.status]})` : ""}`);
process.exit(pushed.status === 201 ? 0 : 1);
