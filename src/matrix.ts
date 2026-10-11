import { join } from "node:path";
import { MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from "matrix-bot-sdk";
import type { Agent } from "./agent.ts";
import { notifyRoom, roomProject, runCommand, type NotifyKind } from "./commands.ts";
import { currentConversation } from "./conversation.ts";
import { replyContent, type FormatOptions, type MatrixText } from "./format.ts";
import type { Store } from "./store.ts";
import { VikunjaAuthError, type Project } from "./vikunja.ts";

// After a fresh start (empty sync store) the first sync replays recent room history. Anything older than this
// before startup is not answered again; messages sent during a short restart still are
const REPLAY_WINDOW_MS = 5 * 60_000;

interface MessageEvent {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content?: {
    msgtype?: string;
    body?: string;
    "m.relates_to"?: Relation;
  };
}

export interface BotOptions {
  homeserverUrl: string;
  accessToken: string;
  allowedUsers: string[];
  dataDir: string;
  agent: Agent;
  store: Store;
  listProjects(): Promise<Project[]>;
  version: string;
  changelog: string;
  // A room's conversation starts over after this much silence
  idleMs: number;
  format: FormatOptions;
}

type Relation = { rel_type?: string; event_id?: string };

export class Bot {
  readonly client: MatrixClient;
  readonly #o: BotOptions;
  // A room is one conversation: its messages are handled strictly in arrival order, one at a time
  readonly #queues = new Map<string, Promise<void>>();
  #vikunjaDown = false;
  #startedAt = 0;
  #userId = "";

  constructor(o: BotOptions) {
    this.#o = o;
    // The crypto store belongs to the device of the access token. A new token needs an empty crypto directory
    this.client = new MatrixClient(
      o.homeserverUrl,
      o.accessToken,
      new SimpleFsStorageProvider(join(o.dataDir, "matrix-sync.json")),
      // 0 is StoreType.Sqlite, a const enum that type stripping can't import
      new RustSdkCryptoStorageProvider(join(o.dataDir, "matrix-crypto"), 0),
    );
  }

  async start(): Promise<void> {
    const { allowedUsers } = this.#o;
    this.client.on("room.invite", async (roomId: string, ev: { sender: string }) => {
      if (allowedUsers.includes(ev.sender)) await this.client.joinRoom(roomId);
      else await this.client.leaveRoom(roomId);
    });
    this.client.on("room.message", (roomId: string, ev: MessageEvent) => this.#enqueue(roomId, ev));
    this.client.on("room.failed_decryption", (roomId: string, _ev: unknown, e: Error) => {
      console.warn(`could not decrypt a message in ${roomId}: ${e.message}`);
    });
    this.#userId = await this.client.getUserId();
    this.#startedAt = Date.now();
    await this.client.start();
    console.log(`matrix: running as ${this.#userId}`);
  }

  stop(): void {
    this.client.stop();
  }

  /** Message to the user outside a conversation (token expiry, Vikunja down, new version): goes to the room set for
   * that kind, else the room they last used. False when there is none yet. */
  async notify(text: string, kind: NotifyKind = "alerts"): Promise<boolean> {
    const room = notifyRoom(this.#o.store, kind);
    if (!room) {
      console.warn(`no room to notify yet, message was: ${text}`);
      return false;
    }
    await this.client.sendMessage(room, replyContent(text, this.#o.format, undefined, undefined, "m.notice"));
    return true;
  }

  setVikunjaDown(down: boolean): void {
    this.#vikunjaDown = down;
  }

  // Synchronous on purpose: the message joins its room's queue before anything else can run
  #enqueue(roomId: string, ev: MessageEvent): void {
    const body = ev.content?.body?.trim();
    const relation = ev.content?.["m.relates_to"];
    if (!body || ev.content?.msgtype !== "m.text") return;
    if (ev.sender === this.#userId || !this.#o.allowedUsers.includes(ev.sender)) return;
    if (relation?.rel_type === "m.replace") return;
    if (ev.origin_server_ts < this.#startedAt - REPLAY_WINDOW_MS) return;

    const run = (this.#queues.get(roomId) ?? Promise.resolve())
      .then(() => this.#handle(roomId, ev, body, relation))
      .catch((e) => console.error("message handling failed:", e));
    this.#queues.set(roomId, run);
    void run.then(() => {
      if (this.#queues.get(roomId) === run) this.#queues.delete(roomId);
    });
  }

  async #handle(roomId: string, ev: MessageEvent, body: string, relation: Relation | undefined): Promise<void> {
    const { agent, store, format, idleMs } = this.#o;
    // Written inside an old thread: answer there so the reply shows next to the question. It still belongs to the
    // room's conversation
    const thread = relation?.rel_type === "m.thread" && relation.event_id ? relation.event_id : undefined;
    const relates = {
      ...(thread ? { rel_type: "m.thread", event_id: thread, is_falling_back: true } : {}),
      "m.in_reply_to": { event_id: ev.event_id },
    };
    const send = (content: MatrixText) => this.client.sendMessage(roomId, { ...content, "m.relates_to": relates });
    const reply = (text: string) => send(replyContent(text, format));

    if (!(await this.client.crypto.isRoomEncrypted(roomId))) {
      await reply("I only work in encrypted rooms. Turn on encryption for this room or start an encrypted direct chat.");
      return;
    }
    store.setState("alert-room", roomId);

    try {
      const { listProjects, version, changelog } = this.#o;
      const answer = await runCommand({
        store, listProjects, version, changelog, idleHours: idleMs / 3_600_000,
        spentToday: () => agent.spentToday(), dailyCap: agent.dailyCap,
        newConversation: () => void currentConversation(store, roomId, ev.origin_server_ts, idleMs, true),
      }, roomId, body);
      if (answer !== undefined) {
        await reply(answer);
        return;
      }
    } catch (e) {
      if (e instanceof VikunjaAuthError) this.#vikunjaDown = true;
      console.error("command failed:", e);
      await reply("That command failed, I couldn't reach Vikunja. Details are in my logs.");
      return;
    }

    // !research <question> or !r <question>: this one message goes to the research model, with web search
    const research = /^!(?:research|r)\b\s*([\s\S]*)$/i.exec(body);
    const text = research ? research[1]!.trim() : body;
    if (research && !text) {
      await reply("Usage: !research <question>, or !r <question>. Only that message uses research; start the next one with !r too if it needs the web.");
      return;
    }
    if (this.#vikunjaDown) {
      await reply("My Vikunja token expired or was revoked, so I can't work on tasks until it's rotated.");
      return;
    }

    const conversation = currentConversation(store, roomId, ev.origin_server_ts, idleMs);
    // A typing notice lasts 30 s; long requests need it renewed
    const typing = () => void this.client.setTyping(roomId, true, 30_000).catch(() => {});
    typing();
    const renew = setInterval(typing, 20_000);
    const progress = research ? await send({ ...replyContent("Researching…", format, undefined, undefined, "m.notice") }).catch(() => undefined) : undefined;
    let outcome = "Research failed.";
    try {
      const res = await agent.turn(conversation, roomId, text, research ? "research" : "task", roomProject(store, roomId));
      if (res.tokenDead) this.#vikunjaDown = true;
      await send(replyContent(res.reply, format, res.footer, res.alert));
      outcome = `Research done: ${res.searches} ${res.searches === 1 ? "search" : "searches"}, $${res.cost.toFixed(4)}.`;
    } catch (e) {
      console.error("turn failed:", e);
      await reply("Something went wrong on my side, nothing was changed after the error. Details are in my logs.");
    } finally {
      clearInterval(renew);
      await this.client.setTyping(roomId, false).catch(() => {});
      if (progress) await this.#edit(roomId, progress, outcome).catch(() => {});
    }
  }

  async #edit(roomId: string, eventId: string, text: string): Promise<void> {
    const content = replyContent(text, this.#o.format, undefined, undefined, "m.notice");
    await this.client.sendMessage(roomId, {
      ...content, body: `* ${content.body}`, "m.new_content": content, "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    });
  }
}
