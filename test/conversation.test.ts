import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeConversations, currentConversation, inResearch, setResearch } from "../src/conversation.ts";
import { Store } from "../src/store.ts";

const H = 3_600_000;

describe("room conversations", () => {
  it("continues while messages keep coming, starts over after the idle time or on !new", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const t0 = Date.parse("2026-10-11T08:00:00Z");
    assert.equal(currentConversation(store, "!a", t0, 3 * H), "!a#1");
    assert.equal(currentConversation(store, "!a", t0 + 2 * H, 3 * H), "!a#1");
    assert.equal(currentConversation(store, "!a", t0 + 4.5 * H, 3 * H), "!a#1"); // 2.5 h after the previous one
    assert.equal(currentConversation(store, "!a", t0 + 8 * H, 3 * H), "!a#2");
    assert.equal(currentConversation(store, "!a", t0 + 8 * H + 1, 3 * H, true), "!a#3");
    assert.equal(currentConversation(store, "!b", t0, 3 * H), "!b#1");
    assert.deepEqual(activeConversations(store), new Set(["!a#3", "!b#1"]));
  });

  it("keeps research on per conversation until it is switched off, a new conversation starts without it", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const t0 = Date.parse("2026-10-11T08:00:00Z");
    const first = currentConversation(store, "!a", t0, 3 * H);
    setResearch(store, first, true);
    assert.equal(inResearch(store, currentConversation(store, "!a", t0 + H, 3 * H)), true);
    assert.equal(inResearch(store, currentConversation(store, "!a", t0 + H, 3 * H, true)), false);
    setResearch(store, first, false);
    assert.equal(inResearch(store, first), false);
  });

  it("doesn't start over for a late-delivered older message", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const t0 = Date.parse("2026-10-11T08:00:00Z");
    currentConversation(store, "!a", t0, 3 * H);
    assert.equal(currentConversation(store, "!a", t0 - 60_000, 3 * H), "!a#1");
    assert.equal(currentConversation(store, "!a", t0 + 2 * H, 3 * H), "!a#1");
  });
});
