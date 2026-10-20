import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spokenCommand, TranscribeError, WhistleClient } from "../src/voice.ts";

describe("spoken commands", () => {
  it("turns 'command <name>' into the typed command, punctuation and case dropped", () => {
    assert.equal(spokenCommand("Command today."), "!today");
    assert.equal(spokenCommand("command, Week!"), "!week");
    assert.equal(spokenCommand("Command costs."), "!cost");
    assert.equal(spokenCommand("Command cost week."), "!cost week");
    assert.equal(spokenCommand("Command cost, Today"), "!cost today");
    assert.equal(spokenCommand("Command undo"), "!undo");
    assert.equal(spokenCommand("Command new."), "!new");
    assert.equal(spokenCommand("Command help"), "!help");
    assert.equal(spokenCommand("Command open"), "!open");
  });

  it("keeps a research question as spoken", () => {
    assert.equal(spokenCommand("Command research, what is the best air purifier under 200 euros?"), "!research what is the best air purifier under 200 euros?");
    assert.equal(spokenCommand("Command R. Is Prague warmer than Vienna?"), "!research Is Prague warmer than Vienna?");
  });

  it("knows the two-word commands and arguments of project and mode", () => {
    assert.equal(spokenCommand("Command notify here."), "!notify-here");
    assert.equal(spokenCommand("Command releases here"), "!releases-here");
    assert.equal(spokenCommand("Command errors here, off."), "!errors-here off");
    assert.equal(spokenCommand("Command project, Home."), "!project home");
    assert.equal(spokenCommand("Command project none"), "!project none");
    assert.equal(spokenCommand("Command mode letters."), "!mode letters");
  });

  it("leaves ordinary speech alone, including sentences with 'command' later in them", () => {
    assert.equal(spokenCommand("Add milk to the shopping list."), "Add milk to the shopping list.");
    assert.equal(spokenCommand("The command structure was unclear."), "The command structure was unclear.");
    assert.equal(spokenCommand("Command"), "Command");
  });

  it("passes an unknown name on as a command, so the user is told it doesn't exist", () => {
    assert.equal(spokenCommand("Command dance."), "!dance");
  });
});

describe("whistle client", () => {
  const fakeFetch = (handler: (url: string, init: RequestInit) => { status: number; json: unknown } | Error) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const r = handler(String(url), init ?? {});
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

  it("posts the audio and returns the text", async () => {
    let seen: { url: string; bytes: number; method?: string } | undefined;
    const f = fakeFetch((url, init) => {
      seen = { url, bytes: (init.body as Uint8Array).byteLength, method: init.method };
      return { status: 200, json: { text: " hello there ", language: "en", seconds: 1.5, elapsed_ms: 300 } };
    });
    const r = await new WhistleClient("http://whistle:8080/", f).transcribe(Buffer.from("abc"));
    assert.deepEqual(r, { text: "hello there", seconds: 1.5 });
    assert.deepEqual(seen, { url: "http://whistle:8080/transcribe", bytes: 3, method: "POST" });
  });

  it("turns the service's errors and an outage into a TranscribeError", async () => {
    const bad = fakeFetch(() => ({ status: 413, json: { error: "audio longer than 600 s" } }));
    await assert.rejects(new WhistleClient("http://w", bad).transcribe(Buffer.alloc(1)), (e) => e instanceof TranscribeError && /HTTP 413.*600 s/.test(e.message));
    const down = fakeFetch(() => new TypeError("fetch failed"));
    await assert.rejects(new WhistleClient("http://w", down).transcribe(Buffer.alloc(1)), (e) => e instanceof TranscribeError && /unreachable/.test(e.message));
    const odd = fakeFetch(() => ({ status: 200, json: { nope: 1 } }));
    await assert.rejects(new WhistleClient("http://w", odd).transcribe(Buffer.alloc(1)), /without text/);
  });
});
