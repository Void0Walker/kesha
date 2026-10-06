import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTokenExpiry } from "../src/expiry.ts";
import { Store } from "../src/store.ts";
import { FakeVikunja } from "./fakes.ts";

const run = (today: string, store: Store, v: FakeVikunja, notes: string[]) =>
  checkTokenExpiry({ expires: "2026-11-05", today, store, vikunja: v, inboxProjectId: 1, notify: async (t) => void notes.push(t) });

describe("token expiry", () => {
  it("does nothing until 7 days before expiry, then reminds once", async () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const v = new FakeVikunja();
    const notes: string[] = [];
    assert.equal(await run("2026-10-28", store, v, notes), "ok");
    assert.equal(await run("2026-10-29", store, v, notes), "reminded");
    assert.equal(await run("2026-10-30", store, v, notes), "already-reminded");

    const tasks = [...v.tasks.values()];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.title, "Rotate Kesha's Vikunja token");
    assert.equal(tasks[0]!.project_id, 1);
    assert.equal(tasks[0]!.due_date, "2026-11-02T12:00:00Z");
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /2026-11-05 \(in 7 days\)/);
  });

  it("reminds again for the next token", async () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const v = new FakeVikunja();
    await run("2026-10-30", store, v, []);
    await checkTokenExpiry({ expires: "2026-12-05", today: "2026-11-30", store, vikunja: v, inboxProjectId: 1, notify: async () => {} });
    assert.equal(v.tasks.size, 2);
  });
});
