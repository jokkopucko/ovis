/** Bun takes handshake headers; lib.dom's browser constructor does not list them. */
export const withHeaders = (headers: Record<string, string>) => (url: string) =>
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(url, { headers });
