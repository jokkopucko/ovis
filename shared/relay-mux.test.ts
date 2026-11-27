import { describe, expect, it, spyOn } from "bun:test";
import {
  decodeFrame, encodeFrame, FrameType, HTTP_END_FLAGS, LIMITS_V1,
  MAX_FRAME_BYTES, MAX_LARGE_WS_MESSAGE_BYTES, MuxProtocolError, REQUEST_HEADERS, RESPONSE_HEADERS,
  KEY_PROOF_FEATURE, SESSION_ERRORS, STREAM_ERRORS, validateHeaders, validateTarget, WS_DATA_FLAGS,
  WS_CONTINUATION_CAPACITY, WS_START_CAPACITY,
} from "./relay-mux.ts";
import type { HeaderList, MuxFrame, SessionError } from "./relay-mux.ts";

const device_id = "0123456789abcdef";
const spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hf5uO5-sEeRjSU-y7ZAaDe_UezLtkBoN79R9Q";
const session = { flags: 0, stream_id: 0 } as const;
const stream = { flags: 0, stream_id: 1 } as const;
const frames: readonly MuxFrame[] = [
  { ...session, type: FrameType.HELLO, payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } },
  { ...session, type: FrameType.WELCOME, payload: { protocol: "ovis-mux", version: 1, features: [], limits: LIMITS_V1, nonce: "A".repeat(43), server_version: "0.4.20", relay_protocol: 1, min_supported_client: "0.4.20" } },
  { ...session, type: FrameType.AUTH, payload: { scheme: "device-key", device_id, signature: "A".repeat(86) } },
  { ...session, type: FrameType.AUTH_OK, payload: { session_id: "a".repeat(32), device_id, role: "drive" } },
  { ...session, type: FrameType.SESSION_ERROR, payload: { code: "protocol_error", message: "x".repeat(256) } },
  { ...session, type: FrameType.GOAWAY, payload: { code: "shutdown", last_open_id: 0x7fffffff, drain_ms: 5000 } },
  { ...session, type: FrameType.PING, payload: 0xffffffffffffffffn },
  { ...session, type: FrameType.PONG, payload: 0xffffffffffffffffn },
  { ...session, type: FrameType.RECEIVED, payload: 0xffffffffffffffffn },
  { ...session, type: FrameType.PAIR, payload: { code: "012345", label: "x".repeat(64), public_key: spki } },
  { ...stream, type: FrameType.HTTP_OPEN, payload: { device_id, method: "POST", target: "/api/pane/input?q=1", headers: [["content-type", "application/octet-stream"]], body: "stream" } },
  { ...stream, type: FrameType.HTTP_ACCEPT, payload: null },
  { ...stream, type: FrameType.HTTP_HEADERS, payload: { status: 599, headers: [["content-type", "application/octet-stream"]] } },
  { ...stream, type: FrameType.HTTP_DATA, payload: new Uint8Array(16376).fill(0xff) },
  { ...stream, type: FrameType.HTTP_END, payload: { trailers: [["etag", "end"]] } },
  { ...stream, type: FrameType.HTTP_STOP_REQUEST, payload: null },
  { ...stream, type: FrameType.WS_OPEN, payload: { device_id, target: "/ws?machine=abc", headers: [], protocols: ["ovis"] } },
  { ...stream, type: FrameType.WS_ACCEPT, payload: { protocol: "ovis", headers: [] } },
  { ...stream, type: FrameType.WS_DATA, flags: 3, payload: { total_message_bytes: 16372, data: new Uint8Array(16372) } },
  { ...stream, type: FrameType.WS_CLOSE, payload: { code: 4008, reason: "x".repeat(123), abort: true } },
  { ...stream, type: FrameType.CREDIT, payload: 0xffffffffffffffffn },
  { ...stream, type: FrameType.RESET, payload: { code: "cancelled", message: "x".repeat(256) } },
];

function wire(type: number, payload: string | Uint8Array, flags = 0, id = type <= 0x0a ? 0 : 1): Uint8Array {
  const data = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const result = new Uint8Array(8 + data.length);
  result[0] = 1; result[1] = type;
  const view = new DataView(result.buffer);
  view.setUint16(2, flags); view.setUint32(4, id);
  result.set(data, 8);
  return result;
}
function rejects(action: () => unknown, code: SessionError = "protocol_error"): void {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(MuxProtocolError);
    if (error instanceof MuxProtocolError) expect(error.code).toBe(code);
    return;
  }
  throw new Error("Expected MuxProtocolError");
}

describe("Mux frame roundtrip", () => {
  for (const frame of frames) {
    it(`roundtrips frame 0x${frame.type.toString(16)} with bounded payload`, () => {
      const encoded = encodeFrame(frame);
      expect(decodeFrame(encoded)).toEqual(frame);
    });
  }
  it("preserves envelope big-endian integers and offset views", () => {
    const frame: MuxFrame = { type: FrameType.HTTP_END, flags: HTTP_END_FLAGS.STOPPED, stream_id: 0x1234567, payload: { trailers: [] } };
    const encoded = encodeFrame(frame);
    expect([...encoded.subarray(0, 8)]).toEqual([1, 0x14, 0, 1, 1, 0x23, 0x45, 0x67]);
    const backing = new Uint8Array(encoded.length + 9);
    backing.set(encoded, 3);
    expect(decodeFrame(backing.subarray(3, 3 + encoded.length))).toEqual(frame);
  });
  it("S25: a held refusal carries its hold state, and only a held refusal does", () => {
    const holds = [{ reason: "join_hold", until: null }, { reason: "join_hold", until: "2026-11-20T05:00:10.000Z" }, { reason: "catching_up" }, { reason: "frozen", block: "b".repeat(64) }] as const;
    for (const hold of holds) {
      const frame: MuxFrame = { ...session, type: FrameType.SESSION_ERROR, payload: { code: "held", message: "", hold } };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
    for (const code of ["not_listed", "admission"] as const) {
      const frame: MuxFrame = { ...session, type: FrameType.SESSION_ERROR, payload: { code, message: "" } };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
    for (const payload of [{ code: "held", message: "" }, { code: "held", message: "", hold: { reason: "soon" } }, { code: "not_listed", message: "", hold: { reason: "catching_up" } }, { code: "auth_failed", message: "", hold: { reason: "catching_up" } }]) {
      rejects(() => decodeFrame(wire(FrameType.SESSION_ERROR, JSON.stringify(payload))));
    }
  });
  it("S25: an app that predates a session error code takes it as a protocol error, its generic failure", () => {
    expect(() => decodeFrame(wire(FrameType.SESSION_ERROR, JSON.stringify({ code: "a_code_from_a_later_release", message: "" })))).toThrow(MuxProtocolError);
    try { decodeFrame(wire(FrameType.SESSION_ERROR, JSON.stringify({ code: "a_code_from_a_later_release", message: "" }))); } catch (error) {
      expect((error as MuxProtocolError).code).toBe("protocol_error");
    }
  });
  it("accepts every session and stream error vocabulary entry", () => {
    for (const code of SESSION_ERRORS.filter((candidate) => candidate !== "held")) {
      const frame: MuxFrame = { ...session, type: FrameType.SESSION_ERROR, payload: { code, message: "" } };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
    for (const code of STREAM_ERRORS) {
      const frame: MuxFrame = { ...stream, type: FrameType.RESET, payload: { code, message: "" } };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });
});

describe("envelope boundaries", () => {
  for (let length = 0; length < 8; length++) {
    it(`rejects ${length}-byte envelope`, () => rejects(() => decodeFrame(new Uint8Array(length))));
  }
  it("rejects 16385 bytes BEFORE JSON.parse", () => {
    const bytes = wire(FrameType.HTTP_HEADERS, " ".repeat(16377));
    const parse = spyOn(JSON, "parse");
    try {
      rejects(() => decodeFrame(bytes));
      expect(parse).not.toHaveBeenCalled();
      console.log("oversize: bytes=16385 error=protocol_error JSON.parse calls=0");
    } finally { parse.mockRestore(); }
  });
  it("rejects an otherwise valid 16385-byte DATA frame", () => {
    rejects(() => decodeFrame(wire(FrameType.HTTP_DATA, new Uint8Array(16377))));
  });
  it("rejects oversized DATA on encode", () => {
    rejects(() => encodeFrame({ ...stream, type: FrameType.HTTP_DATA, payload: new Uint8Array(16377) }));
  });
  it("rejects text-kind mux records", () => {
    // JSON transport input is untrusted, even when a caller bypasses TypeScript.
    rejects(() => Reflect.apply(decodeFrame, undefined, ["not binary"]));
  });
  it("rejects wrong envelope version", () => {
    const bytes = wire(FrameType.PING, new Uint8Array(8));
    bytes[0] = 2;
    rejects(() => decodeFrame(bytes), "unsupported_version");
  });
  for (const type of [0, 0x0b, 0x16, 0x24, 0x32, 255]) {
    it(`rejects unknown type ${type}`, () => rejects(() => decodeFrame(wire(type, ""))));
  }
  for (const id of [0, 2, 0x80000001, 0xffffffff]) {
    it(`rejects reserved stream id ${id}`, () => rejects(() => decodeFrame(wire(FrameType.HTTP_DATA, new Uint8Array([1]), 0, id))));
  }
  it("rejects nonzero session stream id", () => rejects(() => decodeFrame(wire(FrameType.PING, new Uint8Array(8), 0, 1))));
  for (const frame of frames) {
    it(`rejects reserved flags for type ${frame.type}`, () => {
      const bytes = encodeFrame(frame);
      bytes[2] = 0x80;
      rejects(() => decodeFrame(bytes));
    });
  }
  for (const type of [FrameType.HELLO, FrameType.WELCOME, FrameType.AUTH, FrameType.PAIR, FrameType.RESET, FrameType.WS_CLOSE]) {
    it(`rejects class size before parsing type ${type}`, () => {
      const bytes = wire(type, new Uint8Array((type <= 2 ? 4096 : 1024) - 7));
      const parse = spyOn(JSON, "parse");
      try { rejects(() => decodeFrame(bytes)); expect(parse).not.toHaveBeenCalled(); }
      finally { parse.mockRestore(); }
    });
  }
  it("accepts exact metadata class caps", () => {
    for (const frame of frames.filter((f) => f.payload !== null && typeof f.payload === "object"
      && !(f.payload instanceof Uint8Array) && f.type !== FrameType.WS_DATA)) {
      const encoded = encodeFrame(frame);
      const cap = frame.type <= 2 ? 4096
        : [FrameType.HTTP_OPEN, FrameType.HTTP_HEADERS, FrameType.HTTP_END, FrameType.WS_OPEN, FrameType.WS_ACCEPT].some((t) => t === frame.type) ? 16384 : 1024;
      const padded = new Uint8Array(cap).fill(32);
      padded.set(encoded);
      expect(decodeFrame(padded)).toEqual(frame);
    }
  });
  it("rejects malformed UTF-8 JSON", () => {
    rejects(() => decodeFrame(wire(FrameType.HELLO, new Uint8Array([123, 34, 0xc3, 0x28, 34, 58, 49, 125]))));
  });
  for (const source of [
    '{"protocol":"ovis-mux","versions":[1],"features":[],"required_features":[],"versions":[1]}',
    '{"protocol":"ovis-mux","versions":[1],"features":[],"required_features":[],"\\u0076ersions":[1]}',
    '{"protocol":"ovis-mux","versions":[1],"features":[],"required_features":[],"extra":{"a":1,"a":2}}',
    '{"protocol":"ovis-mux","versions":[1],"features":[],"required_features":[],"extra":[{"a":1,"a":2}]}',
    '{"protocol":"ovis-mux","versions":[1],"features":[],"required_features":[],}',
    '{"protocol":"ovis-mux","versions":[1],"features":[],"required_features":[]/*comment*/}',
    '[]', 'null', '{}', '{"x":', '\ufeff{}',
  ]) {
    it(`rejects invalid or duplicate metadata ${source.slice(-40)}`, () => rejects(() => decodeFrame(wire(FrameType.HELLO, source))));
  }
  it("ignores unknown metadata without confusing string literals for keys", () => {
    const frame = frames[0];
    if (!frame || frame.type !== FrameType.HELLO) throw new Error("Missing fixture");
    const source = JSON.stringify({ ...frame.payload, extra: [{ a: '":', b: ["a", "a"] }, { a: 1 }] });
    expect(decodeFrame(wire(FrameType.HELLO, source))).toEqual(frame);
  });
  it("handles deeply nested unknown JSON without recursive scanning", () => {
    const source = '{"protocol":"ovis-mux","versions":[1],"features":[],"required_features":[],"extra":' + "[".repeat(1500) + "0" + "]".repeat(1500) + "}";
    expect(decodeFrame(wire(FrameType.HELLO, source)).type).toBe(FrameType.HELLO);
  });
});

describe("header and target validation", () => {
  it("preserves the complete whitelists including response security headers", () => {
    expect(validateHeaders(REQUEST_HEADERS.map((name) => [name, name === "content-length" ? "0" : "v"]), "request").length).toBe(10);
    const response: HeaderList = RESPONSE_HEADERS.map((name) => [name, name === "content-length" ? "0" : "v"]);
    expect(validateHeaders(response, "response")).toEqual(response);
    for (const name of ["content-security-policy", "x-content-type-options", "cross-origin-resource-policy", "referrer-policy"]) {
      expect(validateHeaders([[name, "v"]], "response")).toEqual([[name, "v"]]);
    }
  });
  it("preserves header duplicates and exact 12288-byte accounting", () => {
    const headers: HeaderList = [["etag", "x".repeat(12280)]];
    expect(validateHeaders(headers, "response")).toEqual(headers);
    expect(validateHeaders([["etag", "a"], ["etag", "b"]], "response")).toEqual([["etag", "a"], ["etag", "b"]]);
  });
  it("accepts 64 header pairs and rejects 65", () => {
    expect(validateHeaders(Array.from({ length: 64 }, () => ["accept", ""]), "request").length).toBe(64);
    rejects(() => validateHeaders(Array.from({ length: 65 }, () => ["accept", ""]), "request"));
  });
  it("rejects oversized UTF-8 header bytes at the exact boundary", () => {
    rejects(() => validateHeaders([["etag", "x".repeat(12281)]], "response"));
    rejects(() => validateHeaders([["etag", "é".repeat(6141)]], "response"));
  });
  for (const headers of [
    [["etag", "x".repeat(12281)]], [["Content-Type", "a"]], [["content-type", "a\r"]],
    [["content-type", "a\n"]], [["content-type", "a\0"]], [["host", "evil"]],
    [["authorization", "secret"]], [["cookie", "secret"]], [["set-cookie", "secret"]],
    [["connection", "keep-alive"]], [["x-forwarded-for", "local"]],
    [["sec-websocket-key", "secret"]], [["content-length", "-1"]],
    [["content-length", "1"], ["content-length", "2"]], [["bad name", "v"]],
  ]) {
    it(`rejects forbidden or malformed headers ${JSON.stringify(headers).slice(0, 70)}`, () => {
      rejects(() => validateHeaders(headers, "request"));
    });
  }
  it("forbids framing and authentication trailers", () => {
    for (const name of ["content-length", "authorization", "cookie", "host", "x-herdr-machine"]) {
      rejects(() => validateHeaders([[name, "0"]], "trailers"));
    }
  });
  it("accepts a 4096-byte target and query-encoded separators", () => {
    expect(validateTarget("/" + "a".repeat(4095))).toHaveLength(4096);
    expect(validateTarget("/api/pane/read?path=a%2Fb")).toBe("/api/pane/read?path=a%2Fb");
  });
  for (const target of [
    "", "//evil/a", "https://evil/a", "/a#b", "/a\\b", "/a\nb", "/a b",
    "/a//b", "/a/", "/a%2fb", "/a%5Cb", "/a/../b", "/%2e/a",
    "/a%00b", "/a%0ab", "/a%", "/" + "a".repeat(4096), "/" + "é".repeat(2048),
  ]) {
    it(`rejects noncanonical target ${target.slice(0, 40)}`, () => rejects(() => validateTarget(target)));
  }
});

describe("metadata constraints", () => {
  const cases: readonly [number, unknown][] = [
    [FrameType.HELLO, { protocol: "ovis-mux", versions: [], features: [], required_features: [] }],
    [FrameType.HELLO, { protocol: "ovis-mux", versions: [1, 1], features: [], required_features: [] }],
    [FrameType.HELLO, { protocol: "ovis-mux", versions: [65536], features: [], required_features: [] }],
    [FrameType.HELLO, { protocol: "ovis-mux", versions: [1], features: [], required_features: ["x"] }],
    [FrameType.HELLO, { protocol: "ovis-mux", versions: [1], features: ["UPPER"], required_features: [] }],
    [FrameType.AUTH, { scheme: "device-token", token: "a".repeat(64) }],
    [FrameType.AUTH, { scheme: "device-key", device_id, signature: "A".repeat(85) + "B" }],
    [FrameType.PAIR, { code: "12345", label: "", public_key: spki }],
    [FrameType.PAIR, { code: "123456", label: "x".repeat(65), public_key: spki }],
    [FrameType.PAIR, { code: "123456", label: "", public_key: "A".repeat(122) }],
    [FrameType.AUTH_OK, { session_id: "a".repeat(32), device_id, role: "admin" }],
    [FrameType.SESSION_ERROR, { code: "bogus", message: "" }],
    [FrameType.RESET, { code: "bogus", message: "" }],
    [FrameType.RESET, { code: "cancelled", message: "é".repeat(129) }],
    [FrameType.GOAWAY, { code: "shutdown", last_open_id: 2, drain_ms: 0 }],
    [FrameType.GOAWAY, { code: "shutdown", last_open_id: 1, drain_ms: 5001 }],
    [FrameType.HTTP_OPEN, { device_id, method: "GET", target: "/", headers: [], body: "stream" }],
    [FrameType.HTTP_OPEN, { device_id, method: "TRACE", target: "/", headers: [], body: "none" }],
    [FrameType.HTTP_HEADERS, { status: 101, headers: [] }],
    [FrameType.HTTP_HEADERS, { status: 600, headers: [] }],
    [FrameType.WS_OPEN, { device_id, target: "/ws", headers: [], protocols: ["a", "a"] }],
    [FrameType.WS_OPEN, { device_id, target: "/ws", headers: [], protocols: ["a b"] }],
    [FrameType.WS_CLOSE, { code: null, reason: "not empty", abort: false }],
    [FrameType.WS_CLOSE, { code: 4008, reason: "x".repeat(124), abort: true }],
  ];
  for (const [index, [type, payload]] of cases.entries()) {
    it(`rejects malformed metadata case ${index}`, () => rejects(() => decodeFrame(wire(type, JSON.stringify(payload)))));
  }
  it("enforces fixed welcome sizes while allowing smaller concurrency", () => {
    const welcome = frames.find((f) => f.type === FrameType.WELCOME);
    if (!welcome || welcome.type !== FrameType.WELCOME) throw new Error("Missing welcome");
    const valid = { ...welcome, payload: { ...welcome.payload, limits: { ...LIMITS_V1, max_streams: 16, max_ws_streams: 4, max_sse_streams: 2 } } };
    expect(decodeFrame(encodeFrame(valid))).toEqual(valid);
    for (const [key, value] of Object.entries(LIMITS_V1)) {
      const invalid = { ...welcome.payload, limits: { ...LIMITS_V1, [key]: value + 1 } };
      rejects(() => decodeFrame(wire(FrameType.WELCOME, JSON.stringify(invalid))));
    }
    rejects(() => decodeFrame(wire(FrameType.WELCOME, JSON.stringify({
      ...welcome.payload, limits: { ...LIMITS_V1, http_window_bytes: 65536 },
    }))));
    const { nonce: _nonce, ...missingNonce } = welcome.payload;
    rejects(() => decodeFrame(wire(FrameType.WELCOME, JSON.stringify(missingNonce))));
  });
  for (const code of [1000, 1008, 1012, 3000, 4008, 4999, null]) {
    it(`preserves legal WS close ${code}`, () => {
      const frame: MuxFrame = { ...stream, type: FrameType.WS_CLOSE, payload: { code, reason: "", abort: false } };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    });
  }
  for (const code of [999, 1004, 1005, 1006, 1015, 2000, 5000]) {
    it(`rejects synthetic or reserved WS close ${code}`, () => rejects(() => decodeFrame(wire(FrameType.WS_CLOSE, JSON.stringify({ code, reason: "", abort: false })))));
  }
  it("rejects nonempty empty frames and wrong-width u64 payloads", () => {
    for (const type of [FrameType.HTTP_ACCEPT, FrameType.HTTP_STOP_REQUEST]) rejects(() => decodeFrame(wire(type, new Uint8Array(1))));
    for (const type of [FrameType.PING, FrameType.PONG, FrameType.RECEIVED, FrameType.CREDIT]) {
      for (const length of [0, 7, 9]) rejects(() => decodeFrame(wire(type, new Uint8Array(length))));
      for (const payload of [-1n, 0x10000000000000000n]) {
        rejects(() => encodeFrame({ type, flags: 0, stream_id: type === FrameType.CREDIT ? 1 : 0, payload }));
      }
    }
  });
  it("rejects empty HTTP DATA and stopped trailers", () => {
    rejects(() => decodeFrame(wire(FrameType.HTTP_DATA, "")));
    rejects(() => decodeFrame(wire(FrameType.HTTP_END, '{"trailers":[["etag","x"]]}', 1)));
  });
});

describe("WS fragment arithmetic", () => {
  for (const length of [0, 1, 16372, 16373, 65536, 65537, 1048576]) {
    it(`roundtrips ${length}-byte message fragments`, () => {
      const data = new Uint8Array(length).map((_, i) => i % 251);
      const received = new Uint8Array(length);
      let offset = 0;
      let count = 0;
      do {
        const start = count === 0;
        const end = Math.min(length, offset + (start ? WS_START_CAPACITY : WS_CONTINUATION_CAPACITY));
        const frame: MuxFrame = {
          ...stream, type: FrameType.WS_DATA,
          flags: (start ? WS_DATA_FLAGS.START | WS_DATA_FLAGS.TEXT : 0) | (end === length ? WS_DATA_FLAGS.END : 0),
          payload: start ? { total_message_bytes: length, data: data.subarray(offset, end) } : { data: data.subarray(offset, end) },
        };
        const encoded = encodeFrame(frame);
        expect(encoded.length).toBeLessThanOrEqual(16384);
        const decoded = decodeFrame(encoded);
        if (decoded.type !== FrameType.WS_DATA) throw new Error("Wrong decoded type");
        received.set(decoded.payload.data, offset);
        offset = end;
        count++;
      } while (offset < length);
      expect(received).toEqual(data);
      if (length === 1048576) expect(count).toBe(65);
    });
  }
  it("fills first and continuation frames to exact 16384-byte capacity", () => {
    const first = encodeFrame({ ...stream, type: FrameType.WS_DATA, flags: 1, payload: { total_message_bytes: 1048576, data: new Uint8Array(16372) } });
    const next = encodeFrame({ ...stream, type: FrameType.WS_DATA, payload: { data: new Uint8Array(16376) } });
    expect(first.length).toBe(16384);
    expect(next.length).toBe(16384);
    expect(MAX_FRAME_BYTES).toBe(first.length);
  });
  for (const [flags, total, length] of [
    [4, undefined, 1], [1, 1, 0], [3, 1, 0], [1, 0, 1], [1, MAX_LARGE_WS_MESSAGE_BYTES + 1, 1],
    [3, 2, 1], [1, 1, 1], [0, undefined, 0], [2, undefined, 0],
    [0, 1, 1], [1, 1048576, 16373], [0, undefined, 16377],
  ] as const) {
    it(`rejects invalid fragment flags=${flags} total=${total} bytes=${length}`, () => {
      rejects(() => encodeFrame({ ...stream, type: FrameType.WS_DATA, flags, payload: { total_message_bytes: total, data: new Uint8Array(length) } }));
    });
  }
  it("rejects truncated START before reading its length", () => {
    for (let length = 0; length < 4; length++) rejects(() => decodeFrame(wire(FrameType.WS_DATA, new Uint8Array(length), 1)));
  });
  it("rejects declared oversize START before any reassembly", () => {
    const payload = new Uint8Array(5);
    new DataView(payload.buffer).setUint32(0, MAX_LARGE_WS_MESSAGE_BYTES + 1);
    rejects(() => decodeFrame(wire(FrameType.WS_DATA, payload, 1)));
  });
});

describe("relay hints", () => {
  const authOk = (relays?: unknown) => ({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
    payload: { session_id: "a".repeat(32), device_id: "b".repeat(16), role: "drive", ...(relays === undefined ? {} : { relays }) } }) as MuxFrame;

  it("carries a PC's relays in AUTH_OK, and none when it names none", () => {
    const relays = ["wss://relay-ap.ovis.sh", "wss://relay.ovis.sh"];
    expect(decodeFrame(encodeFrame(authOk(relays))).payload).toEqual(authOk(relays).payload);
    expect(decodeFrame(encodeFrame(authOk())).payload).not.toHaveProperty("relays");
  });

  it("fits two of the longest relay origins in one AUTH_OK", () => {
    const longest = (letter: string) => `wss://${letter.repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(49)}.example`;
    expect(longest("a").length).toBeLessThanOrEqual(256);
    expect(() => encodeFrame(authOk([longest("a"), longest("e")]))).not.toThrow();
  });

  it("takes only a few wss origins", () => {
    for (const relays of [["https://relay.ovis.sh"], ["wss://relay.ovis.sh/path"], ["wss://user@relay.ovis.sh"], "wss://relay.ovis.sh",
      ["wss://a.example", "wss://b.example", "wss://c.example"]]) {
      expect(() => encodeFrame(authOk(relays))).toThrow(MuxProtocolError);
    }
  });
});

describe("direct carriers", () => {
  const authOk = (direct: unknown) => ({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
    payload: { session_id: "a".repeat(32), device_id: "b".repeat(16), role: "drive", direct } }) as MuxFrame;

  it("carries a PC's private addresses in AUTH_OK", () => {
    const direct = ["ws://192.168.0.10:7319", "ws://10.1.2.3:7319", "ws://172.31.255.1:40000", "ws://169.254.3.4:1"];
    expect(decodeFrame(encodeFrame(authOk(direct))).payload).toEqual(authOk(direct).payload);
  });

  it("carries a PC's Tailscale address in AUTH_OK, from either end of Tailscale's range", () => {
    const direct = ["ws://192.168.0.10:7319", "ws://100.64.0.1:7319", "ws://100.127.255.255:7319"];
    expect(decodeFrame(encodeFrame(authOk(direct))).payload).toEqual(authOk(direct).payload);
  });

  it("takes only ws://<private or Tailscale IPv4>:<port>, at most four", () => {
    for (const direct of [["wss://192.168.0.10:7319"], ["ws://192.168.0.10"], ["ws://192.168.0.10:7319/v1/ws"], ["ws://8.8.8.8:7319"],
      ["ws://127.0.0.1:7319"], ["ws://100.63.255.255:7319"], ["ws://100.128.0.1:7319"], ["ws://172.32.0.1:7319"], ["ws://192.168.0.010:7319"], ["ws://192.168.0.10:65536"],
      ["ws://pc.local:7319"], ["ws://[fe80::1]:7319"], "ws://192.168.0.10:7319",
      ["ws://10.0.0.1:1", "ws://10.0.0.2:1", "ws://10.0.0.3:1", "ws://10.0.0.4:1", "ws://10.0.0.5:1"]]) {
      expect(() => encodeFrame(authOk(direct))).toThrow(MuxProtocolError);
    }
  });
});

describe("key proof (device-row-states T71, T72; S2-13 wire)", () => {
  it("T71: a HELLO that offers key-proof-1 parses", () => {
    const hello: MuxFrame = { ...session, type: FrameType.HELLO, payload: { protocol: "ovis-mux", versions: [1], features: [KEY_PROOF_FEATURE], required_features: [] } };
    expect(KEY_PROOF_FEATURE).toBe("key-proof-1");
    expect(decodeFrame(encodeFrame(hello))).toEqual(hello);
  });
  it("T71: the challenge, the proof and the wait round-trip", () => {
    const frames: MuxFrame[] = [
      { ...session, type: FrameType.KEY_CHALLENGE, payload: { challenge: "A".repeat(43) } },
      { ...session, type: FrameType.KEY_PROVE, payload: { signature: "A".repeat(86) } },
      { ...session, type: FrameType.KEY_PENDING, payload: {} },
    ];
    for (const frame of frames) expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });
  it("T72: the wait carries no fingerprint, whatever the sender put in it", () => {
    const decoded = decodeFrame(wire(FrameType.KEY_PENDING, JSON.stringify({ fingerprint: "AAAA-BBBB" }), 0, 0));
    expect(decoded).toEqual({ ...session, type: FrameType.KEY_PENDING, payload: {} });
  });
  it("T71: a decoder that does not know a frame type refuses it as a protocol error the session reports", () => {
    expect(() => decodeFrame(wire(0x43, "{}", 0, 0))).toThrow(MuxProtocolError);
    try { decodeFrame(wire(0x43, "{}", 0, 0)); } catch (error) { expect((error as MuxProtocolError).code).toBe("protocol_error"); }
  });
  it("T71: the proof frames are session frames only", () => {
    rejects(() => decodeFrame(wire(FrameType.KEY_PENDING, "{}", 0, 1)));
  });
  it("T71: a malformed challenge or proof is a protocol error", () => {
    rejects(() => decodeFrame(wire(FrameType.KEY_CHALLENGE, JSON.stringify({ challenge: "short" }), 0, 0)));
    rejects(() => decodeFrame(wire(FrameType.KEY_PROVE, JSON.stringify({ signature: "A".repeat(85) }), 0, 0)));
  });
});

describe("a join that brings the device's card for the account's signed list", () => {
  const card = "A".repeat(86);
  const request = (extra: Record<string, unknown>) => ({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "Phone", public_key: spki, commitment: "A".repeat(43), ...extra } }) as MuxFrame;
  const authOk = (list?: unknown) => ({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
    payload: { session_id: "a".repeat(32), device_id: "b".repeat(16), role: "drive", ...(list === undefined ? {} : { list }) } }) as MuxFrame;

  it("carries the device's encryption key and its card in PAIR_REQUEST, both or neither", () => {
    const both = request({ list_enc: spki, list_card: card });
    expect(decodeFrame(encodeFrame(both)).payload).toEqual(both.payload);
    expect(decodeFrame(encodeFrame(request({}))).payload).not.toHaveProperty("list_card");
    rejects(() => encodeFrame(request({ list_enc: spki })));
    rejects(() => encodeFrame(request({ list_card: card })));
    rejects(() => encodeFrame(request({ list_enc: "not a key", list_card: card })));
    rejects(() => encodeFrame(request({ list_enc: spki, list_card: "A".repeat(85) })));
  });

  it("reads a PAIR_REQUEST whose card is out of its form as the frame it was before the extension, and says so", () => {
    for (const extra of [{ list_enc: spki }, { list_card: card }, { list_enc: "not a key", list_card: card }, { list_enc: spki, list_card: "A".repeat(85) }, { list_enc: 7, list_card: null }]) {
      const read = decodeFrame(wire(FrameType.PAIR_REQUEST, JSON.stringify({ label: "Phone", public_key: spki, commitment: "A".repeat(43), ...extra }), 0, 0));
      expect(read.payload).toEqual({ label: "Phone", public_key: spki, commitment: "A".repeat(43), list_malformed: true });
    }
    // nobody sends the mark itself
    rejects(() => encodeFrame(request({ list_malformed: true })));
  });

  it("names the list and the place of the entry that let the device in, in AUTH_OK", () => {
    const list = { id: "c".repeat(64), seq: 7, hash: "d".repeat(64) };
    expect(decodeFrame(encodeFrame(authOk(list))).payload).toEqual(authOk(list).payload);
    expect(decodeFrame(encodeFrame(authOk())).payload).not.toHaveProperty("list");
    rejects(() => encodeFrame(authOk({ id: "c".repeat(63), seq: 7, hash: "d".repeat(64) })));
    rejects(() => encodeFrame(authOk({ id: "c".repeat(64), seq: -1, hash: "d".repeat(64) })));
    rejects(() => encodeFrame(authOk({ id: "c".repeat(64), seq: 7 })));
  });
});
