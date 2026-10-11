import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announceRelease, releaseNotes } from "../src/release.ts";
import { Store } from "../src/store.ts";

const CHANGELOG = "# Changelog\n\nIntro.\n\n## 1.1.0\n\n- New thing.\n- Other thing.\n\n## 1.0.0\n\n- First.\n";

describe("release notes", () => {
  it("takes the section of one version", () => {
    assert.equal(releaseNotes(CHANGELOG, "1.1.0"), "- New thing.\n- Other thing.");
    assert.equal(releaseNotes(CHANGELOG, "1.0.0"), "- First.");
    assert.equal(releaseNotes(CHANGELOG, "1.0"), undefined);
    assert.equal(releaseNotes(CHANGELOG, "2.0.0"), undefined);
  });

  it("announces each version once", async () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const sent: string[] = [];
    const run = (version: string) => announceRelease({ version, changelog: CHANGELOG, store, notify: async (t) => (sent.push(t), true) });
    assert.equal(await run("1.0.0"), "announced");
    assert.equal(await run("1.0.0"), "already-announced");
    assert.equal(await run("1.1.0"), "announced");
    assert.deepEqual(sent, ["Kesha 1.0.0 is running. What's new:\n- First.", "Kesha 1.1.0 is running. What's new:\n- New thing.\n- Other thing."]);
  });

  it("announces without notes when the changelog has no section", async () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const sent: string[] = [];
    await announceRelease({ version: "9.9.9", changelog: CHANGELOG, store, notify: async (t) => (sent.push(t), true) });
    assert.deepEqual(sent, ["Kesha 9.9.9 is running."]);
  });

  it("tries again on the next start when there is no room yet", async () => {
    const store = new Store(":memory:", "Europe/Berlin");
    assert.equal(await announceRelease({ version: "1.0.0", changelog: CHANGELOG, store, notify: async () => false }), "no-room");
    assert.equal(await announceRelease({ version: "1.0.0", changelog: CHANGELOG, store, notify: async () => true }), "announced");
  });
});
