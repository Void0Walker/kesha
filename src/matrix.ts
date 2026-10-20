import { join } from "node:path";
import { MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from "matrix-bot-sdk";
import type { Mode, TurnResult } from "./agent.ts";
import { notifyRoom, roomMode, roomProject, runCommand, type NotifyKind, type RoomProject } from "./commands.ts";
import { currentConversation, inResearch, setResearch } from "./conversation.ts";
import { ErrorReporter } from "./errors.ts";
import { replyContent, type FormatOptions, type MatrixText } from "./format.ts";
import { ModelTimeoutError } from "./llm.ts";
import type { Store } from "./store.ts";
import { VikunjaAuthError, type VikunjaApi } from "./vikunja.ts";

// After a fresh start (empty sync store) the first sync replays recent room history, and after a longer outage the
// server delivers what was sent meanwhile. Anything older than this before startup is not answered; the room gets one
// notice saying so. Messages sent during a short restart are still answered
const REPLAY_WINDOW_MS = 5 * 60_000;

export interface MessageEvent {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content?: {
    msgtype?: string;
    body?: string;
    "m.relates_to"?: Relation;
  };
}

/** What the bot uses of matrix-bot-sdk's MatrixClient. Tests pass a fake. */
export interface BotClient {
  on(event: "room.invite", handler: (roomId: string, ev: { sender: string }) => Promise<void>): unknown;
  on(event: "room.message", handler: (roomId: string, ev: MessageEvent) => void): unknown;
  on(event: "room.failed_decryption", handler: (roomId: string, ev: unknown, e: Error) => void): unknown;
  getUserId(): Promise<string>;
  start(): Promise<unknown>;
  stop(): void;
  joinRoom(roomId: string): Promise<unknown>;
  leaveRoom(roomId: string): Promise<unknown>;
  sendMessage(roomId: string, content: object): Promise<string>;
  setTyping(roomId: string, typing: boolean, timeoutMs?: number): Promise<unknown>;
  crypto: { isRoomEncrypted(roomId: string): Promise<boolean> };
}

/** What the bot needs from the Agent. */
export interface TurnAgent {
  turn(conversation: string, room: string, text: string, mode: Mode, project?: RoomProject): Promise<TurnResult>;
  spentToday(): number;
  readonly dailyCap: number;
  readonly researchEnabled: boolean;
}

export interface BotOptions {
  homeserverUrl: string;
  accessToken: string;
  allowedUsers: string[];
  dataDir: string;
  // Tests: a fake instead of a MatrixClient built from the options above
  client?: BotClient;
  agent: TurnAgent;
  store: Store;
  vikunja: VikunjaApi;
  timeZone: string;
  version: string;
  changelog: string;
  // A room's conversation starts over after this much silence
  idleMs: number;
  format: FormatOptions;
}

type Relation = { rel_type?: string; event_id?: string };

export class Bot {
  readonly client: BotClient;
  readonly #o: BotOptions;
  // A room is one conversation: its messages are handled strictly in arrival order, one at a time
  readonly #queues = new Map<string, Promise<void>>();
  readonly #errors: ErrorReporter;
  // Rooms told, this start, that messages from before the replay window were skipped
  readonly #skippedNoticed = new Set<string>();
  #vikunjaDown = false;
  #startedAt = 0;
  #userId = "";

  constructor(o: BotOptions) {
    this.#o = o;
    this.#errors = new ErrorReporter(async (content) => {
      const room = notifyRoom(o.store, "errors");
      if (!room) return false;
      await this.client.sendMessage(room, content);
      return true;
    });
    // The crypto store belongs to the device of the access token. A new token needs an empty crypto directory
    this.client = o.client ?? new MatrixClient(
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

  /** Stops syncing: no new messages are taken. Requests already running go on, see drain. */
  stop(): void {
    this.client.stop();
  }

  /** Waits until every room's queue is empty, at most timeoutMs. Returns how many rooms still had a request running. */
  async drain(timeoutMs: number): Promise<number> {
    const done = Promise.allSettled(this.#queues.values()).then(() => 0);
    const late = new Promise<number>((resolve) => setTimeout(() => resolve(this.#queues.size), timeoutMs).unref());
    return Promise.race([done, late]);
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

  /** Logs a failure and reports it to the room set with !errors-here. Never throws. */
  async failed(what: string, e: unknown, room?: string): Promise<void> {
    console.error(`${what}:`, e);
    await this.#errors.report(what, e, room);
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
    if (ev.origin_server_ts < this.#startedAt - REPLAY_WINDOW_MS) {
      this.#noticeSkipped(roomId);
      return;
    }

    const run = (this.#queues.get(roomId) ?? Promise.resolve())
      .then(() => this.#handle(roomId, ev, body, relation))
      .catch((e) => this.failed("Message handling failed", e, roomId));
    this.#queues.set(roomId, run);
    void run.then(() => {
      if (this.#queues.get(roomId) === run) this.#queues.delete(roomId);
    });
  }

  // Once per room and start: the user shouldn't wait for answers that never come
  #noticeSkipped(roomId: string): void {
    if (this.#skippedNoticed.has(roomId)) return;
    this.#skippedNoticed.add(roomId);
    const since = new Date(this.#startedAt - REPLAY_WINDOW_MS).toLocaleString("sv-SE", { timeZone: this.#o.timeZone, dateStyle: "short", timeStyle: "short" });
    const text = `I was offline for a while, so I'm not answering messages sent before ${since}. Send them again if they still matter.`;
    void this.client.sendMessage(roomId, replyContent(text, this.#o.format, undefined, undefined, "m.notice")).catch((e: unknown) => {
      console.warn(`could not send the skipped-messages notice to ${roomId}:`, e);
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
      const { vikunja, timeZone, version, changelog } = this.#o;
      const answer = await runCommand({
        store, vikunja, timeZone, now: () => new Date(), version, changelog, idleHours: idleMs / 3_600_000,
        spentToday: () => agent.spentToday(), dailyCap: agent.dailyCap,
        newConversation: () => void currentConversation(store, roomId, ev.origin_server_ts, idleMs, true),
      }, roomId, body);
      if (answer !== undefined) {
        await reply(answer);
        return;
      }
    } catch (e) {
      if (e instanceof VikunjaAuthError) this.#vikunjaDown = true;
      // Not awaited: the reply shouldn't wait for the report
      void this.failed(`Command failed: ${body.split(/\s/)[0]}`, e, roomId);
      await reply("That command failed, I couldn't reach Vikunja. Details are in my logs.");
      return;
    }

    // !research <question> or !r <question>: the research model with web search, also for the follow-ups
    const command = /^!(?:research|r)\b\s*([\s\S]*)$/i.exec(body);
    const text = command ? command[1]!.trim() : body;
    if (command && !text) {
      await reply("Usage: !research <question>, or !r <question>. Follow-ups stay with research until I record a task or decision, or until !new.");
      return;
    }
    if (this.#vikunjaDown) {
      await reply("My Vikunja token expired or was revoked, so I can't work on tasks until it's rotated.");
      return;
    }

    const conversation = currentConversation(store, roomId, ev.origin_server_ts, idleMs);
    // A conversation started with !r stays in research until a task or decision is recorded, !new or the idle restart
    const research = command !== null || (agent.researchEnabled && inResearch(store, conversation));
    // A typing notice lasts 30 s; long requests need it renewed
    const typing = () => void this.client.setTyping(roomId, true, 30_000).catch(() => {});
    typing();
    const renew = setInterval(typing, 20_000);
    const progress = research ? await send({ ...replyContent("Researching…", format, undefined, undefined, "m.notice") }).catch(() => undefined) : undefined;
    let outcome = "Research failed.";
    try {
      const mode = research ? "research" : roomMode(store, roomId) === "letters" ? "letters" : "task";
      const res = await agent.turn(conversation, roomId, text, mode, roomProject(store, roomId));
      if (res.tokenDead) this.#vikunjaDown = true;
      if (research && agent.researchEnabled) setResearch(store, conversation, !res.changed);
      await send(replyContent(res.reply, format, res.footer, res.alert));
      outcome = `Research done: ${res.searches} ${res.searches === 1 ? "search" : "searches"}, $${res.cost.toFixed(4)}.`;
    } catch (e) {
      void this.failed(research ? "Research failed" : "Request failed", e, roomId);
      if (e instanceof ModelTimeoutError) {
        outcome = "Research timed out.";
        await reply(`The model stopped answering (${e.message}), so I gave up. Nothing was changed after that. Try again, or ask something narrower.`);
      } else {
        await reply("Something went wrong on my side, nothing was changed after the error. Details are in my logs.");
      }
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
