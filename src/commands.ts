import { addConversationNote, markSnapshotStale } from "./agent.ts";
import { peekConversation } from "./conversation.ts";
import type { ProductChoices } from "./choices.ts";
import { markAnnounced, releaseText } from "./release.ts";
import { RohlikAuthError, type RohlikStatus } from "./rohlik.ts";
import { addDays, type Store } from "./store.ts";
import { dueOf, openTasks } from "./tools.ts";
import { undoLast } from "./undo.ts";
import type { Project, Task, VikunjaApi } from "./vikunja.ts";

// Chat commands other than !research. They never reach the model.

export type NotifyKind = "alerts" | "releases" | "errors";

export interface RoomProject {
  id: number;
  title: string;
}

const projectKey = (room: string) => `room-project:${room}`;
const modeKey = (room: string) => `room-mode:${room}`;

export type RoomMode = "tasks" | "letters";

/** What a room is for, set with !mode. Tasks unless set otherwise. */
export function roomMode(store: Store, room: string): RoomMode {
  return store.getState(modeKey(room)) === "letters" ? "letters" : "tasks";
}

/** The project new tasks in this room go to, set with !project. */
export function roomProject(store: Store, room: string): RoomProject | undefined {
  const s = store.getState(projectKey(room));
  return s ? (JSON.parse(s) as RoomProject) : undefined;
}

/** Where notifications of this kind go: the room set with !notify-here, !releases-here or !errors-here, else the room
 * last used. Error reports only go to a room set for them. */
export function notifyRoom(store: Store, kind: NotifyKind): string | undefined {
  const set = store.getState(`notify-room:${kind}`);
  return kind === "errors" ? set : set ?? store.getState("alert-room");
}

/** What !rohlik needs: Kesha's Rohlík sign-in. */
export interface RohlikLogin {
  status(): RohlikStatus;
  startLogin(): Promise<URL>;
  finishLogin(pasted: string): Promise<void>;
  logout(): Promise<void>;
  readonly choices: ProductChoices;
}

export function help(idleHours: number): string {
  return [
    `Write to me in plain language about your tasks. Each room is one conversation; it starts fresh after ${idleHours} h of silence or with !new.`,
    "",
    "- `!r <question>` or `!research <question>`: research with web search. Follow-ups stay in research until I record a task or decision, or `!new`",
    "- `!shop`: fill the Rohlík cart from the shopping list. Add notes like `!shop no meat this week`. Follow-ups stay with shopping until `!new`. `!rohlik login` signs me in to Rohlík once, `!rohlik choices` shows the products I remember for your items",
    "- `!project <name>`: new tasks in this room go to that project. `!project` shows it, `!project none` removes it",
    "- `!mode letters`: this room drafts letters and emails (formal Czech by default). `!mode tasks` switches back, `!mode` shows it",
    "- `!today`, `!week`, `!open`: what's due today, this week, or all open tasks (this room's project, or all)",
    "- `!undo`: undo my last change in this room",
    "- `!new`: start a fresh conversation in this room",
    "- `!notify-here`: reminders and warnings go to this room",
    "- `!releases-here`: release notes go to this room",
    "- `!errors-here`: details of my errors go to this room, `!errors-here off` stops them",
    "- `!cost`: this month so far, `!cost week`: the last 7 days, `!cost today`: today against the daily cap",
    "- `!help`: this list",
    "",
    "Voice messages work too: I write down what I heard and answer it. Say \"command\" and a name for a command: \"command today\", \"command research ...\", \"command cost week\".",
  ].join("\n");
}

export interface CommandDeps {
  store: Store;
  // Read access for the shortcuts, and the writes of !undo. Answers go to Matrix only, never to the model
  vikunja: VikunjaApi;
  timeZone: string;
  now(): Date;
  spentToday(): number;
  dailyCap: number;
  // Set when shopping has a daily cap of its own
  shoppingToday?: { spent(): number; cap: number };
  version: string;
  changelog: string;
  idleHours: number;
  // Starts a new conversation in the room the command came from
  newConversation(): void;
  // Unset: shopping is off
  rohlik?: RohlikLogin;
}

/** Returns the reply, or undefined when the message is not a command (or is !research / !r, which go to the agent). */
export async function runCommand(d: CommandDeps, room: string, body: string): Promise<string | undefined> {
  const m = /^!([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(body);
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  switch (name) {
    case "research":
    case "r":
    case "shop":
      return undefined;
    case "rohlik":
      return rohlikCommand(d, arg);
    case "help":
      return help(d.idleHours);
    case "new":
      d.newConversation();
      return "New conversation: I've forgotten what we talked about in this room before.";
    case "cost":
      if (/^today$/i.test(arg)) {
        const shop = d.shoppingToday;
        return `Spent today: $${d.spentToday().toFixed(4)} of $${d.dailyCap.toFixed(2)}` +
          (shop ? `, shopping $${shop.spent().toFixed(4)} of $${shop.cap.toFixed(2)}` : "");
      }
      if (/^week$/i.test(arg)) return costWeek(d, room);
      return costMonth(d, room);
    case "today":
    case "week":
    case "open":
      return taskList(d, room, name);
    case "undo":
      return undo(d, room);
    case "notify-here":
      d.store.setState("notify-room:alerts", room);
      return "Reminders and warnings (Vikunja token rotation, Vikunja unreachable) go to this room from now on.";
    case "releases-here":
      d.store.setState("notify-room:releases", room);
      markAnnounced(d.store, d.version);
      return `Release notes go to this room from now on.\n\n${releaseText(d.version, d.changelog)}`;
    case "errors-here":
      if (/^(none|off)$/i.test(arg)) {
        d.store.deleteState("notify-room:errors");
        return "I don't send error details any more, they're only in my logs.";
      }
      d.store.setState("notify-room:errors", room);
      return "Details of my errors (failed requests, timeouts, crashes) go to this room from now on. `!errors-here off` stops them.";
    case "project":
      return projectCommand(d, room, arg);
    case "mode":
      return modeCommand(d, room, arg);
    default:
      return `I don't know !${name}.\n\n${help(d.idleHours)}`;
  }
}

async function projectCommand(d: CommandDeps, room: string, arg: string): Promise<string> {
  const current = roomProject(d.store, room);
  if (!arg) {
    return current
      ? `New tasks in this room go to ${current.title}. Change it with !project <name>, remove it with !project none.`
      : "This room has no default project, new tasks go to the inbox. Set one with !project <name>.";
  }
  if (/^(none|off)$/i.test(arg)) {
    d.store.deleteState(projectKey(room));
    return "This room has no default project any more, new tasks go to the inbox.";
  }

  const projects = (await d.vikunja.listProjects()).filter((p) => !p.is_archived);
  const want = arg.toLocaleLowerCase();
  const exact = projects.filter((p) => p.title.trim().toLocaleLowerCase() === want);
  const found = exact.length ? exact : projects.filter((p) => p.title.toLocaleLowerCase().includes(want));
  if (found.length === 1) {
    const p = found[0]!;
    d.store.setState(projectKey(room), JSON.stringify({ id: p.id, title: p.title } satisfies RoomProject));
    return `New tasks in this room go to ${p.title} from now on, and questions about tasks are about that project unless you name another.`;
  }
  const names = (list: Project[]) => list.map((p) => p.title).join(", ");
  return found.length
    ? `"${arg}" matches several projects: ${names(found)}. Use the full name.`
    : `No project matches "${arg}". Your projects: ${names(projects)}.`;
}

const LIST_LIMIT = 50;
// "2026-10-18" → "Sat 18 Oct"
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

async function taskList(d: CommandDeps, room: string, which: "today" | "week" | "open"): Promise<string> {
  const project = roomProject(d.store, room);
  const now = d.now();
  const today = d.store.today(now);
  const until = which === "today" ? today : which === "week" ? addDays(today, 6) : undefined;
  const localDay = (t: Task) => {
    const due = dueOf(t);
    return due ? new Date(due).toLocaleDateString("sv-SE", { timeZone: d.timeZone }) : undefined;
  };
  const open = await openTasks(d.vikunja, project?.id);
  const incomplete = open.complete ? "" : "\n(There are more open tasks than I can fetch at once; this list may miss some.)";
  const picked = open.tasks
    .map((t) => ({ t, day: localDay(t) }))
    .filter((x) => !until || (x.day !== undefined && x.day <= until))
    // Overdue first, then by date, undated last
    .sort((a, b) => (a.day ?? "9999").localeCompare(b.day ?? "9999") || a.t.id - b.t.id);

  const scope = project ? `in ${project.title}` : "in all projects";
  const what = which === "today" ? "due today or overdue" : which === "week" ? "due this week or overdue" : "open";
  if (!picked.length) return `Nothing ${what} ${scope}.${incomplete}`;
  const names = project ? undefined : new Map((await d.vikunja.listProjects()).map((p): [number, string] => [p.id, p.title]));
  const lines = picked.slice(0, LIST_LIMIT).map(({ t, day }) => {
    const due = day ? ` · ${day < today ? "**overdue** " : ""}${dayLabel(day)}` : "";
    return `- ${t.title} (#${t.id})${due}${names ? ` · ${names.get(t.project_id) ?? `project ${t.project_id}`}` : ""}`;
  });
  const more = picked.length > LIST_LIMIT ? `\n…and ${picked.length - LIST_LIMIT} more` : "";
  const label = which === "today" ? "Due today or overdue" : which === "week" ? "Due this week or overdue" : "Open tasks";
  return `${label} ${scope}:\n${lines.join("\n")}${more}${incomplete}`;
}

function costWeek(d: CommandDeps, room: string): string {
  const r = d.store.costReport(room, 7, d.now());
  const total = r.days.reduce((n, x) => n + x.total, 0);
  const inRoom = r.days.reduce((n, x) => n + x.room, 0);
  const lines = r.days.map((x) => `- ${dayLabel(x.day)}: $${x.total.toFixed(4)}${x.room ? ` (this room $${x.room.toFixed(4)})` : ""}`);
  return [
    `Last 7 days: $${total.toFixed(4)}, this room $${inRoom.toFixed(4)}.`,
    ...lines,
    `${Math.round(r.cachedShare * 100)}% of prompt tokens came from the cache.`,
  ].join("\n");
}

/** The running calendar month, from its 1st to today, as totals: a day-by-day list would be up to 31 lines. */
function costMonth(d: CommandDeps, room: string): string {
  const today = d.store.today(d.now());
  const dayOfMonth = Number(today.slice(8, 10));
  const r = d.store.costReport(room, dayOfMonth, d.now());
  const total = r.days.reduce((n, x) => n + x.total, 0);
  const inRoom = r.days.reduce((n, x) => n + x.room, 0);
  const month = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return [
    `${month} so far (${dayOfMonth} ${dayOfMonth === 1 ? "day" : "days"}): $${total.toFixed(4)}, this room $${inRoom.toFixed(4)}, $${(total / dayOfMonth).toFixed(4)} per day on average.`,
    `${Math.round(r.cachedShare * 100)}% of prompt tokens came from the cache.`,
  ].join("\n");
}

/** !undo, and telling the room's conversation about it: otherwise the model goes on from the undone state. */
async function undo(d: CommandDeps, room: string): Promise<string> {
  const r = await undoLast(d.store, d.vikunja, room);
  const conversation = peekConversation(d.store, room);
  if (r.reverted && conversation) {
    markSnapshotStale(d.store, conversation);
    addConversationNote(d.store, conversation, `the user sent !undo, which reverted my last changes. ${r.message.replace(/\n/g, " ")}`);
  }
  return r.message;
}

function modeCommand(d: CommandDeps, room: string, arg: string): string {
  const current = roomMode(d.store, room);
  const describe = (m: RoomMode) => (m === "letters" ? "drafting letters and emails" : "tasks");
  if (!arg) return `This room is for ${describe(current)}. Switch with !mode letters or !mode tasks.`;
  const next = arg.toLowerCase();
  if (next !== "letters" && next !== "tasks") return "Use !mode letters or !mode tasks.";
  if (next === current) return `This room is already for ${describe(current)}.`;
  if (next === "letters") d.store.setState(modeKey(room), "letters");
  else d.store.deleteState(modeKey(room));
  // Different instructions: start clean instead of carrying the other mode's conversation along
  d.newConversation();
  return next === "letters"
    ? "This room now drafts letters and emails, formal Czech unless you ask otherwise. Describe who it's for and what you need; send !new before the next letter."
    : "This room is for tasks again.";
}

async function rohlikCommand(d: CommandDeps, arg: string): Promise<string> {
  const { rohlik } = d;
  if (!rohlik) return "Shopping is not set up: KESHA_SHOPPING_MODEL is empty.";
  const [sub = "", ...rest] = arg.split(/\s+/);
  try {
    switch (sub.toLowerCase()) {
      case "": {
        const s = rohlik.status();
        if (s.signedIn) return "I'm signed in to Rohlík. `!rohlik logout` signs me out, `!rohlik login` signs in again.";
        return s.pending
          ? "A Rohlík sign-in is waiting: paste the address the browser ended on with `!rohlik code <address>`, or start over with `!rohlik login`."
          : "I'm not signed in to Rohlík. Send `!rohlik login`.";
      }
      case "login": {
        const url = await rohlik.startLogin();
        return [
          "Sign me in to Rohlík:",
          `1. Open ${url.href} and sign in. Rohlík warns that Kesha is not a verified app: that's expected for an app that registers itself, allow it since you started this.`,
          "2. The browser then tries to open a localhost page that fails to load. Copy its whole address and send `!rohlik code <address>` within a few minutes.",
          "The code in it only works once, and only for me.",
        ].join("\n");
      }
      case "code":
        if (!rest.length) return "Send `!rohlik code <the address the browser ended on>`.";
        await rohlik.finishLogin(rest.join(" "));
        return "Signed in to Rohlík. `!shop` fills the cart from your shopping list.";
      case "choices": {
        const list = rohlik.choices.list();
        if (!list.length) return "I don't remember any product choices yet. When you pick a product while shopping, I remember it for next time.";
        return `Products I use for your list:\n${list.map((c) => `- ${c.item} → ${c.product}${c.note ? ` (${c.note})` : ""}`).join("\n")}\n\n\`!rohlik forget <item>\` removes one.`;
      }
      case "forget": {
        const item = rest.join(" ");
        if (!item) return "Send `!rohlik forget <item>`, e.g. `!rohlik forget voda`.";
        return rohlik.choices.forget(item) ? `Forgot the product for "${item}": I'll ask next time.` : `I don't remember a product for "${item}". \`!rohlik choices\` lists them.`;
      }
      case "logout":
        await rohlik.logout();
        return "Signed out of Rohlík: I forgot my tokens. `!rohlik login` signs me in again.";
      default:
        return "Use `!rohlik`, `!rohlik login`, `!rohlik code <address>`, `!rohlik choices`, `!rohlik forget <item>` or `!rohlik logout`.";
    }
  } catch (e) {
    if (e instanceof RohlikAuthError) return e.message;
    console.warn("rohlik sign-in failed:", e);
    return `The Rohlík sign-in failed: ${e instanceof Error ? e.message : String(e)}. Try \`!rohlik login\` again.`;
  }
}
