import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { Store } from "../src/store.ts";

const NOW = new Date("2026-10-11T10:00:00Z");
const call = { thread: "t", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.01, request: { a: 1 }, response: {} };

describe("store", () => {
  it("adds the 0.6.0 columns to a database from an older version, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-store-"));
    try {
      const path = join(dir, "kesha.sqlite");
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, day TEXT NOT NULL, thread TEXT NOT NULL, model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, cost REAL NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL);
        INSERT INTO calls (ts, day, thread, model, prompt_tokens, completion_tokens, cost, request, response)
        VALUES ('2026-10-10T10:00:00Z', '2026-10-10', 't', 'm', 1, 1, 0.5, '{}', '{}');`);
      old.close();
      const store = new Store(path, "Europe/Berlin");
      store.logCall({ ...call, room: "!r", searches: 2, cachedTokens: 900, reasoningTokens: 0 }, NOW);
      const rows = store.db.prepare("SELECT room, searches, cached_tokens FROM calls ORDER BY id").all();
      assert.deepEqual(rows.map((r) => ({ ...r })), [{ room: null, searches: null, cached_tokens: null }, { room: "!r", searches: 2, cached_tokens: 900 }]);
      assert.equal(store.spentOn("2026-10-10"), 0.5);
      store.db.close();
      new Store(path, "Europe/Berlin").db.close(); // opening again doesn't add the columns twice
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forgets every state key of a forgotten conversation, and only those", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    store.saveHistory("!r:x#1", "!r:x", [], 0);
    store.saveHistory("!r:x#11", "!r:x", [], Date.now());
    for (const k of ["snapshot:!r:x#1", "note:!r:x#1", "future-key:!r:x#1", "snapshot:!r:x#11", "conv:!r:x", "announced-version"]) store.setState(k, "v");
    assert.equal(store.forgetIdleThreads(1000), 1);
    const left = (store.db.prepare("SELECT key FROM state ORDER BY key").all() as { key: string }[]).map((r) => r.key);
    assert.deepEqual(left, ["announced-version", "conv:!r:x", "snapshot:!r:x#11"]);
  });

  it("blanks request bodies after the retention time and keeps the costs", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    store.logCall(call, new Date("2026-09-01T10:00:00Z"));
    store.logCall(call, NOW);
    assert.equal(store.pruneCallBodies(30 * 86_400_000, NOW), 1);
    const rows = store.db.prepare("SELECT request, cost FROM calls ORDER BY id").all() as { request: string; cost: number }[];
    assert.deepEqual(rows.map((r) => r.request), ["", '{"a":1}']);
    assert.equal(rows.reduce((n, r) => n + r.cost, 0), 0.02);
    assert.equal(store.pruneCallBodies(30 * 86_400_000, NOW), 0);
  });

  it("gives each conversation a stable session id that doesn't reveal the conversation", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const a = store.sessionId("$event:matrix.example.org");
    assert.equal(store.sessionId("$event:matrix.example.org"), a);
    assert.notEqual(store.sessionId("$other:matrix.example.org"), a);
    assert.doesNotMatch(a, /matrix|example/);
  });
});
