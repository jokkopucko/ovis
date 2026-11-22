import { version } from "../package.json";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "-V" || args[0] === "--version")) {
  console.log(version);
  process.exit(0);
}
console.error("ovis tui: the screen is not built yet; only -V/--version works.");
process.exit(2);
