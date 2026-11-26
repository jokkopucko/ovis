import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { ObservedIngress } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";
import { ConnectionRouteMark } from "./ConnectionRouteMark.tsx";

let page: Page;

beforeEach(() => {
  page = openPage("https://pc.tail1e211e.ts.net/");
  Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
});

afterEach(async () => {
  await page.close();
  setTransport(nativeTransport);
});

const routeShown = () => page.one('[class="conn-route"]').getAttribute("data-route");
const draw = (ingress: ObservedIngress | null) => createElement(SettingsProvider, null, createElement(ConnectionRouteMark, { portal: false, ingress }));

it("keeps the server's word on the route through a failed health read, which clears it", async () => {
  await page.render(draw("funnel"));
  expect(routeShown()).toBe("direct");
  await page.render(draw(null));
  expect(routeShown()).toBe("direct");
});

const inRelayShell = () => {
  const meta = page.window.document.createElement("meta");
  meta.name = "ovis-shell";
  meta.content = "relay";
  page.window.document.head.append(meta);
};
const markText = () => {
  const mark = page.one('[class="conn-route"]');
  return { word: page.one('[class="conn-route"] [class="conn-route-word"]').textContent, title: mark.title };
};

it.each([["direct", "relay-direct"], ["relay", "relay"]] as const)("in the hosted shell, says the relay transport's %s route as %s", async (route, shown) => {
  inRelayShell();
  setTransport({ ...nativeTransport, route } as Transport);
  await page.render(draw(null));
  expect(routeShown()).toBe(shown);
});

it("says a direct carrier on the PC's private address is the same network", async () => {
  inRelayShell();
  setTransport({ ...nativeTransport, route: "direct", directVia: "lan" } as Transport);
  await page.render(draw(null));
  expect(routeShown()).toBe("relay-direct");
  expect(markText()).toEqual({ word: "direct", title: "Directly on the same network, not through the relay" });
});

it("says a direct carrier on the PC's Tailscale address is Tailscale, not the same network", async () => {
  // Given a phone on mobile data with Tailscale on, whose relay channel moved to the PC's 100.64.0.0/10 carrier
  inRelayShell();
  setTransport({ ...nativeTransport, route: "direct", directVia: "tailscale" } as Transport);
  await page.render(draw(null));
  expect(routeShown()).toBe("relay-tailscale");
  expect(markText()).toEqual({ word: "Tailscale", title: "Directly over Tailscale, not through the relay" });
});
