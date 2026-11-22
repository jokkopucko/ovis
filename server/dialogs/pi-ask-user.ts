import type { DialogReader } from "./registry.ts";

/**
 * @eko24ive/pi-ask's ask_user form is read from the web UI's pi extension and answered through
 * pi-ask's own submit event (server/pi-ask-bridge.ts), never from the screen.
 */
export const readers: readonly DialogReader[] = [{
  id: "pi-ask-user",
  agents: ["pi"],
  priority: 85,
  parse: () => null,
  reread: "before-commit",
  list: "none",
}];
