/** A server's relay identity: 32 lowercase hex characters (server/relay/identity.ts). Alone here so the client's page code can check one without loading the offer's cryptography. */
export const SERVER_ID_PATTERN = /^[0-9a-f]{32}$/;
