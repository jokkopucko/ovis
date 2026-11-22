import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { OwnJoins } from "./OwnJoins.tsx";

describe("account joins on the PC's own window", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let joins: { id: string; label: string; asked_at: string; left_ms: number }[];
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
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7317/" }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false, querySelector: () => null, documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
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
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    setTransport(nativeTransport);
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const settle = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); }); };
  const press = async (label: string): Promise<void> => {
    await act(async () => { renderer!.root.findAll((node) => node.type === "button" && text(node) === label)[0]!.props.onClick(); });
  };
  const submit = async (digits: string): Promise<void> => {
    const form = renderer!.root.findByType("form");
    await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: digits }) } } }); });
    await settle();
  };
  const mount = async (): Promise<void> => {
    await act(async () => { renderer = create(<SettingsProvider><OwnJoins /></SettingsProvider>); });
    await settle();
  };

  it("lists a join with no digits and lets it in only with the number typed", async () => {
    await mount();
    expect(text(renderer!.root)).toContain("A device of your account asks to join");
    expect(text(renderer!.root)).toContain("Galaxy S25");
    expect(renderer!.root.findAll((node) => node.type === "form")).toHaveLength(0);
    await press("Type the number");
    await submit("482 913");
    expect(typed).toEqual(["482913"]);
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(0);
  });

  it("sends nothing for a number of another length, and keeps the field open", async () => {
    await mount();
    await press("Type the number");
    await submit("12 345");
    expect(typed).toEqual([]);
    expect(text(renderer!.root.findByProps({ role: "alert" }))).toBe("Type the six digits Galaxy S25 shows.");
    expect(renderer!.root.findAll((node) => node.type === "form")).toHaveLength(1);
  });

  it("keeps the field open and the join waiting when the PC could not be reached", async () => {
    await mount();
    approval = () => Promise.reject(new TypeError("Failed to fetch"));
    await press("Type the number");
    await submit("482913");
    expect(text(renderer!.root.findByProps({ role: "alert" }))).toBe("Could not reach this PC. Try again.");
    expect(renderer!.root.findAll((node) => node.type === "form")).toHaveLength(1);
  });

  it("closes only the field of the join that was answered, and Cancel clears what it said", async () => {
    joins = [...joins, { id: "j2", label: "iPad", asked_at: new Date().toISOString(), left_ms: 60_000 }];
    const answer = Promise.withResolvers<Response>();
    approval = () => answer.promise;
    await mount();
    await press("Type the number");
    await submit("482913");
    await act(async () => { renderer!.root.findAll((node) => node.type === "button" && text(node) === "Cancel")[0]!.props.onClick(); });
    await press("Type the number");
    expect(renderer!.root.findByType("form").findAll((node) => node.type === "label").map(text)).toEqual(["Number on Galaxy S25"]);
    await act(async () => { renderer!.root.findAll((node) => node.type === "button" && text(node) === "Cancel")[0]!.props.onClick(); });
    const presses = renderer!.root.findAll((node) => node.type === "button" && text(node) === "Type the number");
    await act(async () => { presses[1]!.props.onClick(); });
    await act(async () => { answer.resolve(Response.json({ ok: true })); });
    await settle();
    expect(renderer!.root.findByType("form").findAll((node) => node.type === "label").map(text)).toEqual(["Number on iPad"]);
  });

  it("drops the length hint when its field is cancelled", async () => {
    await mount();
    await press("Type the number");
    await submit("12 345");
    await press("Cancel");
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(0);
  });

  it("says a wrong number ended the join", async () => {
    await mount();
    await press("Type the number");
    await submit("111111");
    expect(text(renderer!.root.findByProps({ role: "alert" }))).toBe("That is not the number Galaxy S25 shows. It was not let in; it can ask again.");
  });

  it.each([403, 404, 405])("shows nothing and takes %i from a PC without the route as final, with no warning", async (status) => {
    listAnswer = status;
    await mount();
    expect(renderer!.toJSON()).toBeNull();
    expect(lists).toBe(1);
    expect(warned).not.toHaveBeenCalled();
  });
});
