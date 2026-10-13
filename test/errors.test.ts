import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeError, errorContent, ErrorReporter, PastError } from "../src/errors.ts";
import type { MatrixText } from "../src/format.ts";

function timeout() {
  const cause = new Error("This operation was aborted");
  cause.name = "AbortError";
  const e = new Error("the model sent nothing for 120 s", { cause });
  e.name = "ModelTimeoutError";
  e.stack = `${e.name}: ${e.message}\n    at OpenRouter.complete (file:///app/src/llm.ts:124:17)\n    at async Agent.turn (file:///app/src/agent.ts:305:19)`;
  return e;
}

describe("error reports", () => {
  it("describes the error, its HTTP status, short stack frames and the cause", () => {
    const e = Object.assign(timeout(), { status: 502 });
    const text = describeError(e);
    assert.match(text, /^ModelTimeoutError: the model sent nothing for 120 s \(HTTP 502\)\n {2}at OpenRouter\.complete \(src\/llm\.ts:124:17\)/);
    assert.match(text, /Caused by:\nAbortError: This operation was aborted/);
    assert.equal(describeError("plain string"), "plain string");
  });

  it("reports a crash from the last run as it was described then", () => {
    const details = describeError(timeout());
    const c = errorContent("Crashed, then restarted", new PastError(details));
    assert.equal(c.body, `⚠️ Crashed, then restarted\n\n${details}`);
    assert.match(c.formatted_body, /<code>ModelTimeoutError: the model sent nothing for 120 s<\/code>/);
  });

  it("links the room and escapes everything in the HTML", () => {
    const c = errorContent("Research failed", new Error("<b>bad</b>"), "!abc:example.org");
    assert.match(c.body, /^⚠️ Research failed in https:\/\/matrix\.to\/#\/!abc%3Aexample\.org\n\nError: <b>bad<\/b>/);
    assert.match(c.formatted_body, /<a href="https:\/\/matrix\.to\/#\/!abc%3Aexample\.org">!abc:example\.org<\/a>/);
    assert.doesNotMatch(c.formatted_body, /<b>bad/);
    assert.equal(c.msgtype, "m.notice");
  });

  it("holds back repeats for 15 minutes and counts them in the next report", async () => {
    const sent: MatrixText[] = [];
    let now = 0;
    const r = new ErrorReporter(async (c) => (sent.push(c), true), () => now);
    await r.report("Request failed", timeout(), "!a");
    await r.report("Request failed", timeout(), "!a");
    now = 60_000;
    await r.report("Request failed", timeout(), "!b");
    await r.report("Command failed", timeout());
    assert.equal(sent.length, 2);
    now = 16 * 60_000;
    await r.report("Request failed", timeout(), "!a");
    assert.equal(sent.length, 3);
    assert.match(sent[2]!.body, /\(2 more like this since the last report\)/);
  });

  it("never throws when sending fails", async () => {
    const r = new ErrorReporter(async () => {
      throw new Error("Matrix down");
    });
    const log = console.error;
    console.error = () => {};
    try {
      await r.report("Request failed", new Error("x"));
    } finally {
      console.error = log;
    }
  });
});
