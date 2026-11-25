import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, errorFrom, fetchSession } from "./api.ts";
import { withChatReadDeadline } from "./chatReadDeadline.ts";
import { setCurrentLanguage, translate } from "./i18n.ts";
import { RemoteResponseInvalid, RemoteResponseTooLarge } from "../../server/remote-json.ts";
import { failureReason, machineErrorText, saysHerdrAway, setupErrorLines, setupStepText, uploadFailure, userErrorMessage, userFailure } from "./userError.ts";

const api = (status: number, detail = "herdr said no") => new ApiError("/api/x", status, detail, null);

describe("userErrorMessage", () => {
  afterEach(() => setCurrentLanguage("en"));

  it("tells a signed-out browser to pair again", () => {
    for (const status of [401, 403]) expect(userErrorMessage(api(status))).toEqual({ message: "This browser is not signed in to this PC any more. Pair it again in Settings → Devices and PCs.", detail: "herdr said no" });
  });

  it("says a missing item is gone", () => {
    expect(userErrorMessage(api(404)).message).toBe("That item no longer exists on the PC. Refresh and try again.");
  });

  it("says a conflicting change happened on the PC", () => {
    expect(userErrorMessage(api(409)).message).toBe("It changed on the PC while you were acting. Check it and try again.");
  });

  it("says the PC was too slow, for 408, 504 and an aborted or timed-out request", () => {
    const slow = "The PC took too long to answer. Try again.";
    expect(userErrorMessage(api(408)).message).toBe(slow);
    expect(userErrorMessage(api(504)).message).toBe(slow);
    expect(userErrorMessage(new DOMException("The operation was aborted.", "AbortError")).message).toBe(slow);
    expect(userErrorMessage(new DOMException("signal timed out", "TimeoutError")).message).toBe(slow);
  });

  it("says the PC was too slow when the chat read misses its own deadline", async () => {
    const missed = await withChatReadDeadline(() => new Promise<never>(() => {}), 0).then(() => null, (cause: unknown) => cause);
    expect(userErrorMessage(missed)).toEqual({ message: "The PC took too long to answer. Try again.", detail: "Chat read timed out." });
  });

  it("says the PC could not do it for any other 5xx", () => {
    expect(userErrorMessage(api(500))).toEqual({ message: "The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.", detail: "herdr said no" });
    expect(userErrorMessage(api(502)).message).toBe("The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.");
  });

  it("names the next step when the server's code says its state folder refused the save", () => {
    const refused = new ApiError("/api/preferences", 500, "EACCES: permission denied, open '/state/preferences.json.7.tmp'", "preferences_unwritable");
    expect(userErrorMessage(refused)).toEqual({ message: "The server cannot save settings: check that its state folder is writable.", detail: "EACCES: permission denied, open '/state/preferences.json.7.tmp'" });
  });

  it("ignores inherited object keys when looking up a server error code", () => {
    for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(userErrorMessage(new ApiError("/api/x", 500, "herdr said no", code))).toEqual(userErrorMessage(api(500)));
    }
  });

  it("says the PC cannot be reached when fetch never got an answer", () => {
    for (const words of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(userErrorMessage(new TypeError(words))).toEqual({ message: "Can't reach the PC. Check your connection, then try again.", detail: words });
    }
  });

  it("falls back to a generic sentence for anything else, keeping its words", () => {
    const generic = "Something went wrong. Try again.";
    expect(userErrorMessage(new TypeError("x is not a function"))).toEqual({ message: generic, detail: "x is not a function" });
    expect(userErrorMessage(api(400, "label too long"))).toEqual({ message: generic, detail: "label too long" });
    expect(userErrorMessage("plain string")).toEqual({ message: generic, detail: "plain string" });
  });

  it("leaves out a detail that is empty or the sentence itself", () => {
    expect(userErrorMessage(new Error("")).detail).toBeNull();
    expect(userErrorMessage(new Error("Something went wrong. Try again.")).detail).toBeNull();
  });

  it("answers in the UI language", () => {
    setCurrentLanguage("ko");
    expect(userErrorMessage(new TypeError("Failed to fetch")).message).toBe(translate("ko", "Can't reach the PC. Check your connection, then try again."));
    expect(userErrorMessage(new TypeError("Failed to fetch")).message).not.toBe("Can't reach the PC. Check your connection, then try again.");
  });
});

describe("saysHerdrAway", () => {
  it("reads the server's words for a herdr it could not reach, and no other failure", () => {
    expect(saysHerdrAway("cannot reach herdr at /tmp/x/herdr.sock: connect ENOENT /tmp/x/herdr.sock")).toBe(true);
    expect(saysHerdrAway("Disabled in herdr")).toBe(false);
  });
});

describe("machineErrorText", () => {
  const inKorean = (key: string) => translate("ko", key);

  it("shows the server's sentences for an unusable PC answer in the UI language", () => {
    for (const sentence of [new RemoteResponseTooLarge().message, new RemoteResponseInvalid().message, "Start Ovis on that PC, or start a new herdr here", "Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.",
      "The Ovis chosen on this PC serves herdr-core from a socket that is not this SSH account's own, so it was not used. Choose again, or start a new herdr here.",
      "Choosing this PC's Ovis server over SSH requires Linux or macOS", "Choose this PC's Ovis server or a running herdr session.",
      "A herdr session is already running on this PC. Choose it, or start a new one.", "The herdr session chosen for this PC is no longer running. Start it on that PC and reconnect, or choose again."]) {
      const shown = machineErrorText(sentence, inKorean);
      expect(shown).toBe(translate("ko", sentence));
      expect(shown).not.toBe(sentence);
      expect(machineErrorText(sentence, (key) => translate("en", key))).toBe(sentence);
    }
  });

  it("passes any other words through unchanged", () => {
    expect(machineErrorText("SSH connection ended", inKorean)).toBe("SSH connection ended");
  });
});

describe("the PC proxy's unusable-answer errors", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; setCurrentLanguage("en"); });
  const proxied = [
    { code: "remote_response_too_large", message: new RemoteResponseTooLarge().message },
    { code: "remote_response_invalid", message: new RemoteResponseInvalid().message },
  ];
  const failure = async (error: { code: string; message: string }) => {
    globalThis.fetch = (async () => Response.json({ error }, { status: 502 })) as unknown as typeof fetch;
    return await fetchSession("fixture-remote").then(() => null, (cause: unknown) => cause) as ApiError;
  };

  it("shows their words in the UI language wherever a failure's detail is drawn", async () => {
    setCurrentLanguage("ko");
    for (const error of proxied) {
      const korean = translate("ko", error.message);
      expect(korean).not.toBe(error.message);
      const cause = await failure(error);
      expect(cause).toMatchObject({ status: 502, code: error.code, detail: korean });
      expect(userErrorMessage(cause).detail).toBe(korean);
      expect(userFailure(cause).detail).toBe(korean);
    }
  });

  it("keeps the server's own sentence in English", async () => {
    for (const error of proxied) expect((await failure(error)).detail).toBe(error.message);
  });
});

describe("userFailure", () => {
  afterEach(() => setCurrentLanguage("en"));

  it("names the cause the status gives, with the advice beyond trying again folded beside it", () => {
    expect(userFailure(api(401))).toEqual({ kind: "signed-out", cause: "Not signed in to this PC", advice: "Pair it again in Settings → Devices and PCs.", detail: "herdr said no" });
    expect(userFailure(api(404))).toEqual({ kind: "gone", cause: "It no longer exists on the PC", advice: "Refresh and try again.", detail: "herdr said no" });
    expect(userFailure(api(409))).toEqual({ kind: "changed", cause: "It changed on the PC", advice: "Check it and try again.", detail: "herdr said no" });
    expect(userFailure(new TypeError("Failed to fetch"))).toEqual({ kind: "unreachable", cause: "Can't reach the PC", advice: "Check your connection, then try again.", detail: "Failed to fetch" });
  });

  it("reads a timeout as slow, with trying again as the only advice", async () => {
    for (const cause of [api(408), api(504), new DOMException("signal timed out", "TimeoutError")]) expect(userFailure(cause)).toMatchObject({ kind: "slow", cause: "The PC took too long", advice: null });
    const missed = await withChatReadDeadline(() => new Promise<never>(() => {}), 0).then(() => null, (cause: unknown) => cause);
    expect(userFailure(missed)).toEqual({ kind: "slow", cause: "The PC took too long", advice: null, detail: "Chat read timed out." });
  });

  it("takes the cause from the server's own words when they name one, keeping the words", () => {
    expect(userFailure(api(500, "disk full"))).toEqual({ kind: "refused", cause: "PC disk is full", advice: "Try again; if it keeps failing, restart Ovis on the PC.", detail: "disk full" });
    expect(userFailure(api(500, "ENOSPC: no space left on device, write")).cause).toBe("PC disk is full");
    expect(userFailure(api(500, "EACCES: permission denied, open '/x'")).cause).toBe("No permission on the PC");
    expect(userFailure(new Error("EPERM: operation not permitted")).cause).toBe("No permission on the PC");
  });

  it("knows no cause for any other 5xx or anything else, so the surface offers Try again", () => {
    expect(userFailure(api(500))).toEqual({ kind: "refused", cause: null, advice: "Try again; if it keeps failing, restart Ovis on the PC.", detail: "herdr said no" });
    expect(userFailure(api(400, "label too long"))).toEqual({ kind: "unknown", cause: null, advice: null, detail: "label too long" });
    expect(userFailure("plain string")).toEqual({ kind: "unknown", cause: null, advice: null, detail: "plain string" });
    expect(userFailure(new Error("  ")).detail).toBeNull();
  });

  it("answers in the UI language", () => {
    setCurrentLanguage("ko");
    expect(userFailure(api(500, "disk full")).cause).toBe(translate("ko", "PC disk is full"));
    expect(userFailure(api(500, "disk full")).cause).not.toBe("PC disk is full");
  });
});

describe("setupErrorLines", () => {
  const keyed = (key: string, params?: Record<string, string | number>): string => params === undefined ? key : `${key} ${JSON.stringify(params)}`;

  it("words an older Ovis from its code and versions, a stable target as a plain update", () => {
    expect(setupErrorLines({ error: "This PC runs its own Ovis v0.5.1, older than this app.", error_code: { code: "own_ovis_older", version: "0.5.1", target: "0.5.10" } }, keyed)).toEqual([
      `This PC runs its own Ovis {version}, older than this app. ${JSON.stringify({ version: "v0.5.1" })} Update it to {target} to reconnect. ${JSON.stringify({ target: "v0.5.10" })}`,
    ]);
  });

  it("names a prerelease target a preview and adds that it is a test build, never a plain update", () => {
    for (const target of ["0.5.10-beta.2", "0.5.10-preview.20"]) {
      const lines = setupErrorLines({ error: "x", error_code: { code: "own_ovis_older", version: "0.5.1", target } }, keyed);
      expect(lines).toEqual([
        `This PC runs its own Ovis {version}, older than this app. ${JSON.stringify({ version: "v0.5.1" })} Update it to the preview version {target} to reconnect. ${JSON.stringify({ target: `v${target}` })}`,
        "A preview version is a test build, not a stable release.",
      ]);
    }
  });

  it("leaves out a version the PC did not name", () => {
    expect(setupErrorLines({ error: "x", error_code: { code: "own_ovis_older", version: null, target: null } }, keyed)).toEqual(["This PC runs its own Ovis, older than this app. Update it to reconnect."]);
  });

  it("shows an error with no code in the server's words, as machineErrorText reads them", () => {
    expect(setupErrorLines({ error: "Start Ovis on that PC, or start a new herdr here", error_code: null }, keyed)).toEqual(["Start Ovis on that PC, or start a new herdr here"]);
    expect(setupErrorLines({ error: null }, keyed)).toEqual([]);
  });
});

describe("setupStepText", () => {
  const keyed = (key: string, params?: Record<string, string | number>): string => params === undefined ? key : `${key} ${JSON.stringify(params)}`;

  it("words a step from its code and parameters", () => {
    expect(setupStepText({ step: "Checking the remote environment…", step_code: { code: "checking" } }, keyed)).toBe("Checking the remote environment…");
    expect(setupStepText({ step: "x", step_code: { code: "install_bundle", platform: "linux-x64" } }, keyed)).toBe(`Installing verified {platform} bundle… ${JSON.stringify({ platform: "linux-x64" })}`);
    expect(setupStepText({ step: "x", step_code: { code: "own_update_ask", target: "0.5.10" } }, keyed)).toBe(`Asking this PC's own Ovis to update itself to {target}… ${JSON.stringify({ target: "v0.5.10" })}`);
    expect(setupStepText({ step: "x", step_code: { code: "own_update_ask", target: null } }, keyed)).toBe("Asking this PC's own Ovis to update itself…");
  });

  it("names a prerelease an own Ovis updates to a preview, as the failure card does", () => {
    expect(setupStepText({ step: "x", step_code: { code: "own_update_ask", target: "0.5.10-beta.2" } }, keyed)).toBe(`Asking this PC's own Ovis to update itself to the preview version {target}… ${JSON.stringify({ target: "v0.5.10-beta.2" })}`);
    expect(setupStepText({ step: "x", step_code: { code: "own_update_running", target: "0.5.10-beta.2", stage: "build" } }, keyed))
      .toBe(`This PC's own Ovis is updating itself to the preview version {target}: {stage}… ${JSON.stringify({ target: "v0.5.10-beta.2", stage: "building" })}`);
  });

  it("words an own update's stage, and shows a stage it does not know as that Ovis said it", () => {
    expect(setupStepText({ step: "x", step_code: { code: "own_update_running", target: null, stage: "dependencies" } }, keyed)).toBe(`This PC's own Ovis is updating itself: {stage}… ${JSON.stringify({ stage: "installing dependencies" })}`);
    expect(setupStepText({ step: "x", step_code: { code: "own_update_running", target: null, stage: "verifying" } }, keyed)).toBe(`This PC's own Ovis is updating itself: {stage}… ${JSON.stringify({ stage: "verifying" })}`);
  });

  it("shows a step with no code, from an older server or a PC's own notice, as it came", () => {
    expect(setupStepText({ step: "Waiting for Windows sign-in on this PC.", step_code: null }, keyed)).toBe("Waiting for Windows sign-in on this PC.");
    expect(setupStepText({ step: "Connected" }, keyed)).toBe("Connected");
  });
});

describe("uploadFailure", () => {
  it("names the HTTP status of an answer that came with no words, which other screens leave out", async () => {
    expect(uploadFailure(api(400, "")).detail).toBe("HTTP 400");
    expect(uploadFailure(api(404, "")).detail).toBeNull();
    expect(userFailure(api(400, "")).detail).toBeNull();
    expect(uploadFailure(api(400, "file is empty"))).toEqual(userFailure(api(400, "file is empty")));
    expect(uploadFailure(new Error(" ")).detail).toBeNull();

    const emptyHttp11 = await errorFrom("/api/pane/image", new Response("", { status: 502, statusText: "Bad Gateway" }));
    expect(uploadFailure(emptyHttp11).detail).toBe("HTTP 502");
    expect(userFailure(emptyHttp11).detail).toBe("Bad Gateway");

    const customReason = await errorFrom("/api/pane/image", new Response("", { status: 502, statusText: "Upstream TLS permission denied" }));
    expect(uploadFailure(customReason)).toMatchObject({ kind: "refused", cause: null, detail: "HTTP 502" });
  });
});

describe("failureReason", () => {
  it("says the plain cause, or else the error's own words, so a failed upload's line never ends bare", () => {
    expect(failureReason(userFailure(api(404)))).toBe("It no longer exists on the PC");
    expect(failureReason(userFailure(api(400, "file is empty")))).toBe("file is empty");
    expect(failureReason(uploadFailure(api(400, "")))).toBe("HTTP 400");
    expect(failureReason(userFailure(new Error(" ")))).toBeNull();
  });

  it("caps multiline, Unicode line-break, and overly long diagnostics to a single line", () => {
    const multiline = ["Upload failed", ...Array.from({ length: 60 }, (_, i) => `detail line ${i + 1}`)].join("\n");
    expect(failureReason(uploadFailure(api(502, multiline)))).toBe("Upload failed");
    expect(failureReason(uploadFailure(api(502, `Upload failed${"\u2028".repeat(60)}tail`)))).toBe("Upload failed");
    expect(failureReason(uploadFailure(api(502, "\n  First diagnostic line  \nsecond line")))).toBe("First diagnostic line");
    const longLine = "x".repeat(300);
    const reason = failureReason(uploadFailure(api(502, longLine)));
    expect(reason).not.toBeNull();
    expect(reason!.length).toBeLessThanOrEqual(161);
    expect(reason!.endsWith("…")).toBe(true);
  });
});
