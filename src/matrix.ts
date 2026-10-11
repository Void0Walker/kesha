import { join } from "node:path";
import { MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from "matrix-bot-sdk";
import type { Agent } from "./agent.ts";
import type { Store } from "./store.ts";

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
    "m.relates_to"?: { rel_type?: string; event_id?: string };
  };
}

export interface BotOptions {
  homeserverUrl: string;
  accessToken: string;
  allowedUsers: string[];
  dataDir: string;
  agent: Agent;
  store: Store;
}

export class Bot {
  readonly client: MatrixClient;
  readonly #o: BotOptions;
  // One turn at a time per thread, so a quick follow-up doesn't race the previous answer
  readonly #queues = new Map<string, Promise<void>>();
  #vikunjaDown = false;
  #startedAt = 0;

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
    this.client.on("room.message", (roomId: string, ev: MessageEvent) => {
      this.#onMessage(roomId, ev).catch((e) => console.error("message handling failed:", e));
    });
    this.client.on("room.failed_decryption", (roomId: string, _ev: unknown, e: Error) => {
      console.warn(`could not decrypt a message in ${roomId}: ${e.message}`);
    });
    this.#startedAt = Date.now();
    await this.client.start();
    console.log(`matrix: running as ${await this.client.getUserId()}`);
  }

  stop(): void {
    this.client.stop();
  }

  /** Message to the user outside a conversation (token expiry, Vikunja down, new version): goes to the room they
   * last used. False when there is none yet. */
  async notify(text: string): Promise<boolean> {
    const room = this.#o.store.getState("alert-room");
    if (!room) {
      console.warn(`no room to notify yet, message was: ${text}`);
      return false;
    }
    await this.client.sendMessage(room, { msgtype: "m.notice", body: text });
    return true;
  }

  setVikunjaDown(down: boolean): void {
    this.#vikunjaDown = down;
  }

  async #onMessage(roomId: string, ev: MessageEvent): Promise<void> {
    const { allowedUsers, agent, store } = this.#o;
    const body = ev.content?.body?.trim();
    const relation = ev.content?.["m.relates_to"];
    if (!body || ev.content?.msgtype !== "m.text") return;
    if (ev.sender === (await this.client.getUserId()) || !allowedUsers.includes(ev.sender)) return;
    if (relation?.rel_type === "m.replace") return;
    if (ev.origin_server_ts < this.#startedAt - REPLAY_WINDOW_MS) return;

    // Each Matrix thread is one conversation. A top-level message starts a new thread rooted at itself
    const thread = relation?.rel_type === "m.thread" && relation.event_id ? relation.event_id : ev.event_id;
    const reply = (text: string) =>
      this.client.sendMessage(roomId, {
        msgtype: "m.text",
        body: text,
        "m.relates_to": { rel_type: "m.thread", event_id: thread, is_falling_back: true, "m.in_reply_to": { event_id: ev.event_id } },
      });

    if (!(await this.client.crypto.isRoomEncrypted(roomId))) {
      await reply("I only work in encrypted rooms. Turn on encryption for this room or start an encrypted direct chat.");
      return;
    }
    store.setState("alert-room", roomId);

    if (body === "!cost") {
      await reply(`Spent today: $${agent.spentToday().toFixed(4)} of $${agent.dailyCap.toFixed(2)}`);
      return;
    }
    // !research <question> turns the thread into a research thread: the research model, with web search
    const research = /^!research\b\s*([\s\S]*)$/i.exec(body);
    const text = research ? research[1]!.trim() : body;
    if (research && !text) {
      await reply("Usage: !research <question>. Follow-ups in the same thread stay in research mode.");
      return;
    }
    if (this.#vikunjaDown) {
      await reply("My Vikunja token expired or was revoked, so I can't work on tasks until it's rotated.");
      return;
    }

    if (research) store.setThreadMode(thread, "research");
    const mode = store.threadMode(thread) === "research" ? "research" : "task";

    const previous = this.#queues.get(thread) ?? Promise.resolve();
    const run = previous.then(async () => {
      await this.client.setTyping(roomId, true, 30_000).catch(() => {});
      try {
        const res = await agent.turn(thread, roomId, text, mode);
        if (res.tokenDead) this.#vikunjaDown = true;
        await reply([res.reply, res.footer, res.alert && `⚠️ ${res.alert}`].filter(Boolean).join("\n\n"));
      } catch (e) {
        console.error("turn failed:", e);
        await reply("Something went wrong on my side, nothing was changed after the error. Details are in my logs.");
      } finally {
        await this.client.setTyping(roomId, false).catch(() => {});
      }
    });
    this.#queues.set(thread, run);
    await run;
    if (this.#queues.get(thread) === run) this.#queues.delete(thread);
  }
}
