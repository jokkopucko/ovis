import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { OwnJoinCard, OwnJoins } from "./OwnJoins.tsx";

describe("account joins on the PC's own window", () => {
  let page: Page;
  let joins: { id: string; label: string; asked_at: string; left_ms: number; digits?: string; list_unknown?: true }[];
  let listAnswer: number;
  let lists: number;
  let typed: string[];
  let approval: (() => Promise<Response>) | null;
  let warned: ReturnType<typeof spyOn>;

  beforeEach(() => {
    joins = [{ id: "j1", label: "Galaxy S25", asked_at: new Date().toISOString(), left_ms: 60_000 }];
    listAnswer = 200;
    lists = 0;
    typed = [];
    approval = null;
    page = openPage("http://127.0.0.1:7317/");
    Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0" });
    Object.defineProperty(page.window.navigator, "maxTouchPoints", { configurable: true, value: 0 });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input), "http://127.0.0.1:7317").pathname;
      if (path === "/api/relay/joins") {
        lists++;
        return listAnswer === 200 ? Response.json({ joins }) : Response.json({ error: { code: "x", message: "x" } }, { status: listAnswer });
      }
      if (path === "/api/relay/join") {
        const body = JSON.parse(String(init?.body)) as { id: string; digits: string };
        typed.push(body.digits);
        if (approval !== null) return approval();
        joins = [];
        return body.digits === "482913" ? Response.json({ ok: true }) : Response.json({ error: { code: "wrong_digits", message: "no" } }, { status: 409 });
      }
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    setTransport({ ...nativeTransport, fetch: fetch as typeof nativeTransport.fetch });
    warned = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await page.close();
    setTransport(nativeTransport);
    mock.restore();
  });

  const text = () => page.container.textContent ?? "";
  const buttons = (label: string) => [...page.container.querySelectorAll("button")].filter((node) => node.textContent === label);
  const settle = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); }); };
  const press = async (label: string): Promise<void> => {
    await act(async () => { buttons(label)[0]!.click(); });
  };
  const submit = async (digits: string): Promise<void> => {
    await page.type(page.one<HTMLInputElement>("form input"), digits);
    const form = page.window.document.querySelector("form");
    if (!form) throw new Error("Missing join form");
    await act(async () => { form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
  };
  const mount = async (): Promise<void> => {
    await page.render(<SettingsProvider><OwnJoins /></SettingsProvider>);
    await settle();
  };

  it("lists a join with no digits and lets it in only with the number typed", async () => {
    await mount();
    expect(text()).toContain("A device of your account asks to join");
    expect(text()).toContain("Galaxy S25");
    expect(page.container.querySelectorAll("form")).toHaveLength(0);
    await press("Type the number");
    await submit("482 913");
    expect(typed).toEqual(["482913"]);
    expect(page.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("leaves the first phone's join, which this PC's window asks to allow beside its digits, out of the typed list", async () => {
    joins = [{ id: "j0", label: "Android · Chrome", asked_at: new Date().toISOString(), left_ms: 60_000, digits: "482913" }];
    await mount();
    expect(page.container.querySelectorAll('[data-testid="own-joins"]')).toHaveLength(0);
  });

  it("sends nothing for a number of another length, and keeps the field open", async () => {
    await mount();
    await press("Type the number");
    await submit("12 345");
    expect(typed).toEqual([]);
    expect(page.one('[role="alert"]').textContent).toBe("Type the six digits Galaxy S25 shows.");
    expect(page.container.querySelectorAll("form")).toHaveLength(1);
  });

  it("keeps the field open and the join waiting when the PC could not be reached", async () => {
    await mount();
    approval = () => Promise.reject(new TypeError("Failed to fetch"));
    await press("Type the number");
    await submit("482913");
    expect(page.one('[role="alert"]').textContent).toBe("Could not reach this PC. Try again.");
    expect(page.container.querySelectorAll("form")).toHaveLength(1);
  });

  it("closes only the field of the join that was answered, and Cancel clears what it said", async () => {
    joins = [...joins, { id: "j2", label: "iPad", asked_at: new Date().toISOString(), left_ms: 60_000 }];
    const answer = Promise.withResolvers<Response>();
    approval = () => answer.promise;
    await mount();
    await press("Type the number");
    await submit("482913");
    await press("Cancel");
    await press("Type the number");
    expect([...page.one("form").querySelectorAll("label")].map((node) => node.textContent)).toEqual(["Number on Galaxy S25"]);
    await press("Cancel");
    const presses = buttons("Type the number");
    await act(async () => { presses[1]!.click(); });
    await act(async () => { answer.resolve(Response.json({ ok: true })); });
    await settle();
    expect([...page.one("form").querySelectorAll("label")].map((node) => node.textContent)).toEqual(["Number on iPad"]);
  });

  it("drops the length hint when its field is cancelled", async () => {
    await mount();
    await press("Type the number");
    await submit("12 345");
    await press("Cancel");
    expect(page.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("offers no number to a join from an app that knows no signed list: it says to update that app", async () => {
    joins = [{ ...joins[0]!, list_unknown: true }];
    await mount();
    expect(buttons("Type the number")).toEqual([]);
    expect([...page.container.querySelectorAll("form")]).toEqual([]);
    expect(text()).toContain("Galaxy S25 cannot be let in here: this PC lets devices into your account by its signed list, and Galaxy S25 asked as an Ovis older than 0.5.10 does. Update Ovis on Galaxy S25, then have it ask to join again.");
  });

  it("says a wrong number ended the join", async () => {
    await mount();
    await press("Type the number");
    await submit("111111");
    expect(page.one('[role="alert"]').textContent).toBe("That is not the number Galaxy S25 shows. It was not let in; it can ask again.");
  });

  describe("#16: the card a members join pops on the PC's own window", () => {
    let decided = 0;
    const card = async (list = joins): Promise<void> => {
      decided = 0;
      await page.render(null);
      await page.render(<SettingsProvider><OwnJoinCard joins={list} onDecided={() => { decided++; }} /></SettingsProvider>);
    };
    const cards = () => page.container.querySelectorAll('[data-testid="own-join-card"]');

    it("pops by itself with the device's name and a field that never takes the focus", async () => {
      await card();
      expect(cards()).toHaveLength(1);
      expect(text()).toContain("\"Galaxy S25\" asks to join your account");
      const field = page.one("input");
      expect(document.activeElement).not.toBe(field);
      await submit("482913");
      expect(typed).toEqual(["482913"]);
      expect(decided).toBe(1);
    });

    it("pops for a join from an app that knows no signed list, a first join too, with no field: it says to update that app", async () => {
      await card([{ ...joins[0]!, digits: "482913", list_unknown: true }]);
      expect(cards()).toHaveLength(1);
      expect([...page.container.querySelectorAll("input")]).toEqual([]);
      expect(text()).toContain("Galaxy S25 cannot be let in here: this PC lets devices into your account by its signed list, and Galaxy S25 asked as an Ovis older than 0.5.10 does. Update Ovis on Galaxy S25, then have it ask to join again.");
      await press("Not now");
      expect(cards()).toHaveLength(0);
      expect(typed).toEqual([]);
    });

    it("one wrong number ends that join and says so", async () => {
      await card();
      await submit("111111");
      expect(typed).toEqual(["111111"]);
      expect(page.one('[role="alert"]').textContent).toBe("That is not the number Galaxy S25 shows. It was not let in; it can ask again.");
      // the PC ended it (joins = []): the card no longer asks for a number
      await card([]);
      expect(cards()).toHaveLength(0);
    });

    it("asks for one join at a time, leaves a first join to the tap prompt, and Not now only hides it here", async () => {
      const both = [{ id: "j0", label: "Android", asked_at: new Date().toISOString(), left_ms: 60_000, digits: "123456" }, ...joins, { id: "j2", label: "iPad", asked_at: new Date().toISOString(), left_ms: 60_000 }];
      await card(both);
      expect([...page.container.querySelectorAll("form")]).toHaveLength(1);
      expect(text()).toContain("Galaxy S25");
      expect(text()).not.toContain("iPad");
      await press("Not now");
      expect(text()).toContain("iPad");
      expect(typed).toEqual([]);
      await press("Not now");
      expect(cards()).toHaveLength(0);
    });
  });

  it.each([403, 404, 405])("shows nothing and takes %i from a PC without the route as final, with no warning", async (status) => {
    listAnswer = status;
    await mount();
    expect(page.container.childNodes).toHaveLength(0);
    expect(lists).toBe(1);
    expect(warned).not.toHaveBeenCalled();
  });
});
