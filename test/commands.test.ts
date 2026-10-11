import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { help, notifyRoom, roomProject, runCommand, type CommandDeps } from "../src/commands.ts";
import { announceRelease } from "../src/release.ts";
import { Store } from "../src/store.ts";
import type { Project } from "../src/vikunja.ts";

const project = (id: number, title: string, is_archived = false): Project => ({ id, title, description: "", is_archived });
const PROJECTS = [project(1, "Inbox"), project(2, "Home appliances"), project(3, "Home office"), project(4, "Old stuff", true)];

function setup() {
  const store = new Store(":memory:", "Europe/Berlin");
  let projectCalls = 0;
  let newConversations = 0;
  const deps: CommandDeps = {
    store, spentToday: () => 0.1234, dailyCap: 1, version: "1.2.0", changelog: "## 1.2.0\n\n- Rooms.\n", idleHours: 3,
    listProjects: async () => (projectCalls++, PROJECTS), newConversation: () => void newConversations++,
  };
  return {
    store, deps, run: (body: string, room = "!a") => runCommand(deps, room, body),
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
