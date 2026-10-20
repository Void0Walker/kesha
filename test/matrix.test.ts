import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TurnResult } from "../src/agent.ts";
import { Bot, type BotClient, type MessageEvent, type TurnAgent } from "../src/matrix.ts";
import { Store } from "../src/store.ts";
import { FakeVikunja } from "./fakes.ts";

const USER = "@jana:example.org";
const BOT = "@kesha:example.org";

type Handlers = { message?: (roomId: string, ev: MessageEvent) => void; invite?: (roomId: string, ev: { sender: string }) => Promise<void> };

/** Records what the bot sends; every room is encrypted. */
class FakeClient implements BotClient {
  readonly handlers: Handlers = {};
  readonly sent: { room: string; content: Record<string, unknown> }[] = [];
  readonly joined: string[] = [];
  readonly left: string[] = [];
  stopped = false;
  crypto = { isRoomEncrypted: async () => true };

  on(event: string, handler: unknown): unknown {
    if (event === "room.message") this.handlers.message = handler as Handlers["message"];
    if (event === "room.invite") this.handlers.invite = handler as Handlers["invite"];
    return this;
  }
  async getUserId() { return BOT; }
  async start() {}
  stop() { this.stopped = true; }
  async joinRoom(roomId: string) { this.joined.push(roomId); }
  async leaveRoom(roomId: string) { this.left.push(roomId); }
  async sendMessage(room: string, content: object) {
    this.sent.push({ room, content: content as Record<string, unknown> });
    return `$sent${this.sent.length}`;
  }
  async setTyping() {}

  bodies(room?: string) {
    return this.sent.filter((s) => !room || s.room === room).map((s) => String(s.content.body));
  }
}

/** Answers every turn after `release` resolves, so tests control when a request ends. */
class FakeAgent implements TurnAgent {
  readonly turns: { conversation: string; text: string; mode: string }[] = [];
  release: Promise<void> = Promise.resolve();
  readonly dailyCap = 1;
  readonly researchEnabled = false;
  async turn(conversation: string, _room: string, text: string, mode: string): Promise<TurnResult> {
    this.turns.push({ conversation, text, mode });
    await this.release;
    return { reply: `Done: ${text}`, cost: 0.001, searches: 0 };
  }
  spentToday() { return 0; }
}

async function setup() {
  const client = new FakeClient();
  const agent = new FakeAgent();
  const store = new Store(":memory:", "Europe/Berlin");
  const bot = new Bot({
    homeserverUrl: "https://m.example", accessToken: "tk", allowedUsers: [USER], dataDir: "/nonexistent", client, agent, store,
    vikunja: new FakeVikunja(), timeZone: "Europe/Berlin", version: "1.6.0", changelog: "", idleMs: 3_600_000, format: {},
  });
  await bot.start();
  return { bot, client, agent, store };
}

let n = 0;
const message = (body: string, o: { sender?: string; ts?: number; msgtype?: string } = {}): MessageEvent => ({
  event_id: `$ev${++n}`,
  sender: o.sender ?? USER,
  origin_server_ts: o.ts ?? Date.now(),
  content: { msgtype: o.msgtype ?? "m.text", body },
});

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("matrix bot", () => {
  it("answers an allowed user in a thread on their message, and ignores everyone else", async () => {
    const { client, agent } = await setup();
    client.handlers.message!("!room", message("add milk"));
    client.handlers.message!("!room", message("spam", { sender: "@stranger:example.org" }));
    client.handlers.message!("!room", message("echo", { sender: BOT }));
    client.handlers.message!("!room", message("a picture", { msgtype: "m.image" }));
    await settled();
    assert.deepEqual(agent.turns.map((t) => t.text), ["add milk"]);
    assert.deepEqual(client.bodies(), ["Done: add milk"]);
    const relates = client.sent[0]!.content["m.relates_to"] as { "m.in_reply_to": { event_id: string } };
    assert.equal(relates["m.in_reply_to"].event_id, `$ev${n - 3}`);
  });

  it("handles a room's messages one at a time, in order, and rooms independently", async () => {
    const { client, agent } = await setup();
    let release!: () => void;
    agent.release = new Promise((r) => (release = r));
    client.handlers.message!("!a", message("first"));
    client.handlers.message!("!a", message("second"));
    client.handlers.message!("!b", message("other room"));
    await settled();
    // The second message of room a waits for the first; room b doesn't
    assert.deepEqual(agent.turns.map((t) => t.text), ["first", "other room"]);
    release();
    await settled();
    await settled();
    assert.deepEqual(agent.turns.map((t) => t.text), ["first", "other room", "second"]);
    assert.deepEqual(client.bodies("!a"), ["Done: first", "Done: second"]);
  });

  it("joins rooms the allowed user invites it to and leaves the others", async () => {
    const { client } = await setup();
    await client.handlers.invite!("!theirs", { sender: USER });
    await client.handlers.invite!("!spam", { sender: "@stranger:example.org" });
    assert.deepEqual(client.joined, ["!theirs"]);
    assert.deepEqual(client.left, ["!spam"]);
  });

  it("skips messages from before the replay window, with one notice per room", async () => {
    const { client, agent } = await setup();
    const old = Date.now() - 10 * 60_000;
    client.handlers.message!("!room", message("while I was down", { ts: old }));
    client.handlers.message!("!room", message("also then", { ts: old + 1000 }));
    client.handlers.message!("!room", message("just now"));
    await settled();
    assert.deepEqual(agent.turns.map((t) => t.text), ["just now"]);
    const bodies = client.bodies();
    assert.equal(bodies.length, 2);
    assert.match(bodies[0]!, /^I was offline for a while, so I'm not answering messages sent before \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./);
    assert.equal(client.sent[0]!.content.msgtype, "m.notice");
    assert.equal(bodies[1], "Done: just now");
  });

  it("drains: stop takes no new messages, the request in flight still answers", async () => {
    const { bot, client, agent } = await setup();
    let release!: () => void;
    agent.release = new Promise((r) => (release = r));
    client.handlers.message!("!room", message("slow one"));
    await settled();
    bot.stop();
    assert.equal(client.stopped, true);
    const draining = bot.drain(5_000);
    release();
    assert.equal(await draining, 0);
    assert.deepEqual(client.bodies(), ["Done: slow one"]);
  });

  it("drain gives up after the timeout and says how many rooms were still busy", async () => {
    const { bot, client, agent } = await setup();
    let release!: () => void;
    agent.release = new Promise((r) => (release = r));
    client.handlers.message!("!a", message("slow"));
    client.handlers.message!("!b", message("slower"));
    await settled();
    assert.equal(await bot.drain(20), 2);
    // Let the requests end: a request in flight renews the typing notice on a timer, which would keep the test process alive
    release();
    await settled();
    assert.deepEqual(client.bodies().sort(), ["Done: slow", "Done: slower"]);
  });

  it("reports a failed request to the user without taking the queue down", async () => {
    const { client, agent } = await setup();
    agent.turn = async () => { throw new Error("boom"); };
    client.handlers.message!("!room", message("break"));
    await settled();
    await settled();
    assert.match(client.bodies()[0]!, /Something went wrong on my side/);
    agent.turn = FakeAgent.prototype.turn;
    client.handlers.message!("!room", message("again"));
    await settled();
    await settled();
    assert.equal(client.bodies().at(-1), "Done: again");
  });
});
