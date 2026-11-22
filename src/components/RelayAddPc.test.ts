import { describe, expect, it } from "bun:test";

import { addressOf, publicHttp } from "./RelayAddPc.tsx";

describe("an address typed on Add a PC", () => {
  it("reads it as people write it: http for a bare IPv4 address, https for a name, a whole URL as it is", () => {
    const read = (text: string) => addressOf(text)?.href ?? null;
    expect(read("192.168.0.12:7421")).toBe("http://192.168.0.12:7421/");
    expect(read(" 100.101.102.103 ")).toBe("http://100.101.102.103/");
    expect(read("my-pc.tailnet.ts.net")).toBe("https://my-pc.tailnet.ts.net/");
    expect(read("my-pc.tailnet.ts.net:8443")).toBe("https://my-pc.tailnet.ts.net:8443/");
    expect(read("http://my-pc.local:7421")).toBe("http://my-pc.local:7421/");
  });

  it("takes nothing that is not an http or https address", () => {
    for (const text of ["", "   ", "javascript:alert(1)", "ftp://pc.example", "https://", "http:/desk.local", "https:desk.local"]) expect(addressOf(text)).toBeNull();
    expect(addressOf("my-pc:7421")?.href).toBe("https://my-pc:7421/");
  });

  it("warns before plain http leaves this device, a home network or a tailnet", () => {
    for (const text of ["http://203.0.113.9:7421", "http://pc.example.com"]) expect(publicHttp(addressOf(text)!)).toBe(true);
    for (const text of ["192.168.0.12:7421", "http://10.0.0.2", "http://100.101.102.103", "http://pc.local:7421", "http://pc:7421", "https://pc.example.com", "http://my-pc.tailnet.ts.net"]) expect(publicHttp(addressOf(text)!)).toBe(false);
  });
});
