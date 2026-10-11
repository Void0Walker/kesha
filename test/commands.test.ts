import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { help, notifyRoom, roomProject, runCommand, type CommandDeps } from "../src/commands.ts";
import { announceRelease } from "../src/release.ts";
import { openTasks } from "../src/tools.ts";
import { Store } from "../src/store.ts";
import type { Project } from "../src/vikunja.ts";
import { FakeVikunja } from "./fakes.ts";

const NOW = new Date("2026-10-11T08:00:00Z"); // Sun 11 Oct, 10:00 in Berlin

const project = (id: number, title: string, is_archived = false): Project => ({ id, title, description: "", is_archived });
const PROJECTS = [project(1, "Inbox"), project(2, "Home appliances"), project(3, "Home office"), project(4, "Old stuff", true)];

function setup() {
  const store = new Store(":memory:", "Europe/Berlin");
  const v = new FakeVikunja();
  v.projects = PROJECTS;
  let projectCalls = 0;
  const listProjects = v.listProjects.bind(v);
  v.listProjects = () => (projectCalls++, listProjects());
  let newConversations = 0;
  const deps: CommandDeps = {
    store, vikunja: v, timeZone: "Europe/Berlin", now: () => NOW,
    spentToday: () => 0.1234, dailyCap: 1, version: "1.2.0", changelog: "## 1.2.0\n\n- Rooms.\n", idleHours: 3,
    newConversation: () => void newConversations++,
  };
  return {
    store, v, deps, run: (body: string, room = "!a") => runCommand(deps, room, body),
    projectCalls: () => projectCalls, newConversations: () => newConversations,
  };
}

describe("commands", () => {
  it("leaves plain messages and !research to the agent", async () => {
    const { run } = setup();
    assert.equal(await run("what is open?"), undefined);
    assert.equal(await run("!research best kettle"), undefined);
    assert.equal(await run("!r best kettle"), undefined);
  });

  it("answers !help without Vikunja or the model, and unknown commands with the help", async () => {
    const { run, projectCalls } = setup();
    assert.equal(await run("!help"), help(3));
    assert.match(help(3), /fresh after 3 h of silence or with !new/);
    assert.match((await run("!frobnicate"))!, /I don't know !frobnicate/);
    assert.equal(projectCalls(), 0);
  });

  it("!new starts a new conversation", async () => {
    const { run, newConversations } = setup();
    assert.match((await run("!new"))!, /New conversation/);
    assert.equal(newConversations(), 1);
  });

  it("shows today's spend", async () => {
    const { run } = setup();
    assert.equal(await run("!cost"), "Spent today: $0.1234 of $1.00");
  });

  it("sets a room's project by exact name, then by unique part of it", async () => {
    const { store, run } = setup();
    assert.match((await run("!project home appliances"))!, /go to Home appliances/);
    assert.deepEqual(roomProject(store, "!a"), { id: 2, title: "Home appliances" });
    assert.match((await run("!project office", "!b"))!, /go to Home office/);
    assert.deepEqual(roomProject(store, "!b"), { id: 3, title: "Home office" });
    assert.match((await run("!project"))!, /go to Home appliances/);
  });

  it("refuses ambiguous, unknown and archived projects", async () => {
    const { store, run } = setup();
    assert.match((await run("!project home"))!, /matches several projects: Home appliances, Home office/);
    assert.match((await run("!project garden"))!, /No project matches "garden"\. Your projects: Inbox, Home appliances, Home office\./);
    assert.match((await run("!project old stuff"))!, /No project matches/);
    assert.equal(roomProject(store, "!a"), undefined);
  });

  it("removes a room's project", async () => {
    const { store, run } = setup();
    await run("!project inbox");
    assert.match((await run("!project none"))!, /no default project any more/);
    assert.equal(roomProject(store, "!a"), undefined);
  });

  it("routes notifications to the rooms set for them, else the room last used", async () => {
    const { store, run } = setup();
    store.setState("alert-room", "!last");
    assert.equal(notifyRoom(store, "alerts"), "!last");
    await run("!notify-here", "!alerts");
    assert.equal(notifyRoom(store, "alerts"), "!alerts");
    assert.equal(notifyRoom(store, "releases"), "!last");
  });

  it("!releases-here posts the current notes there and doesn't announce them again", async () => {
    const { store, deps, run } = setup();
    assert.equal(await run("!releases-here", "!rel"), "Release notes go to this room from now on.\n\nKesha 1.2.0 is running. What's new:\n- Rooms.");
    assert.equal(notifyRoom(store, "releases"), "!rel");
    assert.equal(await announceRelease({ version: "1.2.0", changelog: deps.changelog, store, notify: async () => true }), "already-announced");
  });
});

describe("task shortcuts", () => {
  const PRIVATE = [{ id: 9, title: "private" }];

  it("!today lists overdue and due-today tasks of the room's project, overdue first, without private tasks", async () => {
    const { v, run } = setup();
    await run("!project home appliances");
    v.add({ title: "Fix seal", project_id: 2, due_date: "2026-10-11T15:00:00Z" });
    v.add({ title: "Descale kettle", project_id: 2, due_date: "2026-10-09T10:00:00Z" });
    v.add({ title: "Buy filter", project_id: 2, due_date: "2026-10-14T10:00:00Z" });
    v.add({ title: "Therapy", project_id: 2, due_date: "2026-10-11T09:00:00Z", labels: PRIVATE });
    v.add({ title: "Other project", project_id: 3, due_date: "2026-10-11T09:00:00Z" });
    assert.equal(await run("!today"), [
      "Due today or overdue in Home appliances:",
      "- Descale kettle (#2) · **overdue** Fri 9 Oct",
      "- Fix seal (#1) · Sun 11 Oct",
    ].join("\n"));
    assert.match((await run("!week"))!, /Buy filter \(#3\) · Wed 14 Oct/);
  });

  it("!open covers all projects in a room without one, with project names, and pages past 50", async () => {
    const { v, run } = setup();
    for (let i = 0; i < 60; i++) v.add({ title: `Task ${i}`, project_id: 1 + (i % 2) });
    const out = (await run("!open"))!;
    assert.match(out, /^Open tasks in all projects:/);
    assert.match(out, /- Task 0 \(#1\) · Inbox/);
    assert.match(out, /- Task 1 \(#2\) · Home appliances/);
    assert.match(out, /…and 10 more$/);
  });

  it("says when nothing is due", async () => {
    const { run } = setup();
    assert.equal(await run("!today"), "Nothing due today or overdue in all projects.");
  });
});

describe("!cost week", () => {
  it("sums the last 7 days for all rooms and this room, with the cache share", async () => {
    const { store, run } = setup();
    const log = (room: string | undefined, cost: number, ts: string) =>
      store.logCall({ thread: "t", ...(room ? { room } : {}), model: "m", promptTokens: 1000, completionTokens: 10, cachedTokens: 500, cost, request: {}, response: {} }, new Date(ts));
    log("!a", 0.01, "2026-10-11T07:00:00Z");
    log("!b", 0.02, "2026-10-10T07:00:00Z");
    log(undefined, 0.04, "2026-10-01T07:00:00Z"); // older than 7 days
    const out = (await run("!cost week"))!;
    assert.match(out, /^Last 7 days: \$0\.0300, this room \$0\.0100\./);
    assert.match(out, /- Sun 11 Oct: \$0\.0100 \(this room \$0\.0100\)/);
    assert.match(out, /- Sat 10 Oct: \$0\.0200\n/);
    assert.match(out, /50% of prompt tokens came from the cache\.$/);
  });
});

describe("calendar days and long lists", () => {
  it("!week reaches the 7th day across the October clock change", async () => {
    const { v, deps } = setup();
    v.add({ title: "Seventh day", due_date: "2026-10-26T09:00:00Z" });
    const late = { ...deps, now: () => new Date("2026-10-19T22:30:00Z") }; // Tue 20 Oct 00:30 CEST
    assert.match((await runCommand(late, "!a", "!week"))!, /Seventh day \(#1\) · Mon 26 Oct/);
  });

  it("!cost week lists 7 different days across the March clock change", async () => {
    const { store, deps } = setup();
    store.logCall({ thread: "t", room: "!a", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.05, request: {}, response: {} }, new Date("2027-03-28T10:00:00Z"));
    const late = { ...deps, now: () => new Date("2027-03-28T22:30:00Z") }; // Mon 29 Mar 00:30 CEST
    const out = (await runCommand(late, "!a", "!cost week"))!;
    assert.match(out, /- Sun 28 Mar: \$0\.0500/);
    const days = out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2, 12));
    assert.equal(new Set(days).size, 7);
  });

  it("says when a task list may be incomplete", async () => {
    const { v, deps } = setup();
    for (let i = 0; i < 120; i++) v.add({ title: `T${i}` });
    assert.equal((await openTasks(v)).complete, true);
    const few = await openTasks(v, undefined, 2);
    assert.deepEqual([few.tasks.length, few.complete], [100, false]);
    assert.doesNotMatch((await runCommand(deps, "!a", "!open"))!, /may miss some/);
  });
});
