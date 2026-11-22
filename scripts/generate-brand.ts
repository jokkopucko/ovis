import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const icon = join(root, "app/assets/icon-only.png");
const sheep = join(root, "app/assets/ovis-sheep.png");
const preview = join(root, "ovis-site/assets/og-icon.png");
const NAVY = "0x2e3a59";
mkdirSync(join(root, "public/icons"), { recursive: true });

function exportImage(source: string, path: string, filter: string, extra: string[] = []): void {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-vf", filter, "-frames:v", "1", "-threads", "1", ...extra, join(root, path),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not export ${path}`);
  console.log(path);
}

for (const size of [192, 512]) {
  exportImage(icon, `public/icons/icon-${size}.png`, `scale=${size}:${size}:flags=lanczos`);
  const inset = Math.round(size * 0.76);
  exportImage(icon, `public/icons/icon-maskable-${size}.png`,
    `scale=${inset}:${inset}:flags=lanczos,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=${NAVY}`);
}
// Android draws a notification's small icon from its alpha alone: the sheep becomes white on
// transparent, cropped to it, its closed eyes and mouth left out so the face still reads.
// Without it Chrome shows its own bell.
exportImage(sheep, "public/icons/badge-96.png",
  "crop=1024:966:0:52,pad=1024:1024:0:(oh-ih)/2:color=0x00000000,scale=96:96:flags=lanczos,format=rgba,geq=r=255:g=255:b=255:a='alpha(X,Y)*clip((r(X,Y)+g(X,Y)+b(X,Y))/3-110,0,40)/40'");
exportImage(icon, "public/apple-touch-icon.png", "scale=180:180:flags=lanczos");
exportImage(icon, "public/favicon.png", "scale=64:64:flags=lanczos");
exportImage(icon, "public/favicon.ico", "scale=32:32:flags=lanczos", ["-c:v", "bmp"]);
// GitHub and the chat apps want 1280 × 640: scaled to that width, the empty band above and below
// the icon is trimmed evenly
exportImage(preview, "public/social-preview.png", "scale=1280:672:flags=lanczos,crop=1280:640:0:16");
