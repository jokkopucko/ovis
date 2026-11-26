import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  calculateGenerator, cpaceIsk, formatPairCode, generatorString, normalizePairCode, PairCodeGuest, PairCodeHost,
  PairCodeExpiredError, PairCodeProtocolError, prependLen, randomPairCode, scalarFromLittleEndian, scalarMult, scalarMultVfy, splitPairCode, typedPairCode,
} from "./relay-pair-code.ts";

const hex = (text: string) => hexToBytes(text.replace(/\s+/g, ""));

// draft-irtf-cfrg-cpace-21, Appendix B.3 (CPACE-RISTR255-SHA512)
const V = {
  prs: utf8ToBytes("Password"),
  ci: hex("0b415f696e69746961746f720b425f726573706f6e646572"),
  sid: hex("7e4b4791d6a8ef019b936c79fb7f2c57"),
  generatorString: `11435061636552697374726574746f3235350850617373776f726464${"00".repeat(28 * 3 + 16)}180b415f696e69746961746f
    720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57`,
  g: "222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56",
  ya: "da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08",
  Ya: "d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157",
  yb: "d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d",
  Yb: "3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258",
  K: "80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f",
  isk: `b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c
    3fa2068af7900447`,
};

describe("CPace ristretto255 against the draft's test vectors", () => {
  test("prepend_len (A.1.2)", () => {
    expect(bytesToHex(prependLen(new Uint8Array(0)))).toBe("00");
    expect(bytesToHex(prependLen(utf8ToBytes("1234")))).toBe("0431323334");
    expect(bytesToHex(prependLen(new Uint8Array(128)).slice(0, 2))).toBe("8001");
  });

  test("generator string, generator, shares, K and ISK (B.3.1-B.3.5)", () => {
    expect(bytesToHex(generatorString(V.prs, V.ci, V.sid))).toBe(V.generatorString.replace(/\s+/g, ""));
    const g = calculateGenerator(V.prs, V.ci, V.sid);
    expect(bytesToHex(g.toBytes())).toBe(V.g);
    const ya = scalarFromLittleEndian(hex(V.ya));
    const yb = scalarFromLittleEndian(hex(V.yb));
    expect(bytesToHex(scalarMult(ya, g))).toBe(V.Ya);
    expect(bytesToHex(scalarMult(yb, g))).toBe(V.Yb);
    const k = scalarMultVfy(ya, hex(V.Yb))!;
    expect(bytesToHex(k)).toBe(V.K);
    expect(bytesToHex(scalarMultVfy(yb, hex(V.Ya))!)).toBe(V.K);
    expect(bytesToHex(cpaceIsk(V.sid, k, hex(V.Ya), utf8ToBytes("ADa"), hex(V.Yb), utf8ToBytes("ADb")))).toBe(V.isk.replace(/\s+/g, ""));
  });

  test("scalar_mult_vfy with valid and invalid inputs (B.3.10, B.3.11)", () => {
    const s = scalarFromLittleEndian(hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05"));
    expect(bytesToHex(scalarMultVfy(s, hex("2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c"))!))
      .toBe("7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e");
    expect(scalarMultVfy(s, hex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c"))).toBeNull();
    expect(scalarMultVfy(s, new Uint8Array(32))).toBeNull();
    expect(scalarMultVfy(s, new Uint8Array(31))).toBeNull();
  });
});

describe("the code", () => {
  test("reads a typed code the way a person writes it", () => {
    expect(normalizePairCode("ab3de-fghjk")).toBe("AB3DEFGHJK");
    expect(normalizePairCode(" o1il2 34567 ")).toBe("0111234567");
    expect(normalizePairCode("AB3DEFGH")).toBeNull();
    expect(normalizePairCode("AB3DEFGHJU")).toBeNull();
    expect(formatPairCode("AB3DEFGHJK")).toBe("AB3DE-FGHJK");
    expect(splitPairCode("ab3de-fghjk")).toEqual({ nameplate: "AB3", password: "DEFGHJK" });
    expect(() => splitPairCode("AB3DEFGHJ")).toThrow(PairCodeProtocolError);
  });

  test("the code field shows the dash once the first five are typed, and lets Backspace pass it", () => {
    expect(typedPairCode("ab3d", false)).toBe("AB3D");
    expect(typedPairCode("ab3de", false)).toBe("AB3DE-");
    expect(typedPairCode("AB3DEF", false)).toBe("AB3DE-F");
    expect(typedPairCode("AB3DE-FGHJK", false)).toBe("AB3DE-FGHJK");
    // a pasted code with spaces or without its dash
    expect(typedPairCode(" ab3de fghjk ", false)).toBe("AB3DE-FGHJK");
    // anything else stays, so the field shows what the lookup refuses
    expect(typedPairCode("ab3de.fghjk", false)).toBe("AB3DE-.FGHJK");
    expect(typedPairCode("АВ3DE", false)).toBe("АВ3DE-");
    expect(typedPairCode("  -  ", false)).toBe("  -  ");
    // the dash just deleted stays deleted; one more Backspace takes the fifth character
    expect(typedPairCode("AB3DE", true)).toBe("AB3DE");
    expect(typedPairCode("AB3D", true)).toBe("AB3D");
    expect(typedPairCode("AB3DE-F", true)).toBe("AB3DE-F");
    expect(typedPairCode("AB3DE-", true)).toBe("AB3DE-");
  });

  test("a fresh code is canonical", () => {
    for (let index = 0; index < 50; index++) {
      const code = randomPairCode();
      expect(normalizePairCode(code)).toBe(code);
    }
  });

  test.each([
    ["AB3D𠮷", "AB3D𠮷-"],
    ["ABCD😀", "ABCD😀-"],
    ["ABC😀", "ABC😀"],
  ])("places the dash on a code point boundary in %s", (input, expected) => {
    expect(typedPairCode(input, false)).toBe(expected);
  });
});

describe("the exchange", () => {
  const offer = JSON.stringify({ v: 1, server_id: "0".repeat(32), relay: "wss://relay.ovis.sh", code: "123456" });

  test("a device that knows the code gets the offer", () => {
    const host = new PairCodeHost("AB3DEFGHJK");
    const guest = new PairCodeGuest("ab3de-fghjk");
    const reply = host.answer(guest.answer(host.hello()), offer);
    expect(reply).not.toBeNull();
    expect(guest.open(reply!)).toBe(offer);
  });

  test("a wrong password gets nothing from the PC, and the PC's offer cannot be opened with it", () => {
    const host = new PairCodeHost("AB3DEFGHJK");
    const guest = new PairCodeGuest("AB3DEFGHJM");
    expect(host.answer(guest.answer(host.hello()), offer)).toBeNull();
  });

  test("a device that answers a PC with another password cannot open what it sends", () => {
    const right = new PairCodeHost("AB3DEFGHJK");
    const guest = new PairCodeGuest("AB3DEFGHJK");
    const m2 = guest.answer(right.hello());
    // a PC (or a relay acting as one) that guessed wrong: its box is under another key
    const impostor = new PairCodeHost("AB3ZZZZZZZ");
    const impostorGuest = new PairCodeGuest("AB3ZZZZZZZ");
    const box = impostor.answer(impostorGuest.answer(impostor.hello()), offer)!;
    expect(() => guest.open(box)).toThrow(PairCodeProtocolError);
    expect(right.answer(m2, offer)).not.toBeNull();
  });

  test("another nameplate is another channel, even with the same password", () => {
    const host = new PairCodeHost("AB3DEFGHJK");
    const guest = new PairCodeGuest("XY9DEFGHJK");
    expect(host.answer(guest.answer(host.hello()), offer)).toBeNull();
  });

  test("the identity or a broken point in a message aborts the exchange", () => {
    const host = new PairCodeHost("AB3DEFGHJK");
    const hello = JSON.parse(new TextDecoder().decode(host.hello())) as { sid: string };
    const zero = btoa(String.fromCharCode(...new Uint8Array(32))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const forged = utf8ToBytes(JSON.stringify({ v: 1, sid: hello.sid, ya: zero }));
    expect(() => new PairCodeGuest("AB3DEFGHJK").answer(forged)).toThrow(PairCodeProtocolError);
    const m2 = utf8ToBytes(JSON.stringify({ yb: zero, confirm: zero }));
    expect(() => host.answer(m2, offer)).toThrow(PairCodeProtocolError);
  });

  test("a PC whose six-digit code is gone tells a device that knew the code, and sends no offer", () => {
    const host = new PairCodeHost("AB3DEFGHJK");
    const guest = new PairCodeGuest("AB3DEFGHJK");
    const reply = host.answer(guest.answer(host.hello()), null);
    expect(reply).not.toBeNull();
    expect(() => guest.open(reply!)).toThrow(PairCodeExpiredError);
  });

  test("one exchange answers one device once", () => {
    const host = new PairCodeHost("AB3DEFGHJK");
    const guest = new PairCodeGuest("AB3DEFGHJK");
    const m2 = guest.answer(host.hello());
    expect(host.answer(m2, offer)).not.toBeNull();
    expect(() => host.answer(m2, offer)).toThrow(PairCodeProtocolError);
  });
});
