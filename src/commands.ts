import { markAnnounced, releaseText } from "./release.ts";
import type { Store } from "./store.ts";
import { dueOf, openTasks } from "./tools.ts";
import { undoLast } from "./undo.ts";
import type { Project, Task, VikunjaApi } from "./vikunja.ts";

// Chat commands other than !research. They never reach the model.

export type NotifyKind = "alerts" | "releases";

export interface RoomProject {
  id: number;
  title: string;
}

const projectKey = (room: string) => `room-project:${room}`;

/** The project new tasks in this room go to, set with !project. */
export function roomProject(store: Store, room: string): RoomProject | undefined {
  const s = store.getState(projectKey(room));
  return s ? (JSON.parse(s) as RoomProject) : undefined;
}

/** Where notifications of this kind go: the room set with !notify-here or !releases-here, else the room last used. */
export function notifyRoom(store: Store, kind: NotifyKind): string | undefined {
  return store.getState(`notify-room:${kind}`) ?? store.getState("alert-room");
}

export function help(idleHours: number): string {
  return [
    `Write to me in plain language about your tasks. Each room is one conversation; it starts fresh after ${idleHours} h of silence or with !new.`,
    "",
    "- `!r <question>` or `!research <question>`: answer this message with web search",
    "- `!project <name>`: new tasks in this room go to that project. `!project` shows it, `!project none` removes it",
    "- `!today`, `!week`, `!open`: what's due today, this week, or all open tasks (this room's project, or all)",
    "- `!undo`: undo my last change in this room",
    "- `!new`: start a fresh conversation in this room",
    "- `!notify-here`: reminders and warnings go to this room",
    "- `!releases-here`: release notes go to this room",
    "- `!cost`: today's spend, `!cost week`: the last 7 days",
    "- `!help`: this list",
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
  version: string;
  changelog: string;
  idleHours: number;
  // Starts a new conversation in the room the command came from
  newConversation(): void;
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
      return undefined;
    case "help":
      return help(d.idleHours);
    case "new":
      d.newConversation();
      return "New conversation: I've forgotten what we talked about in this room before.";
    case "cost":
      return /^week$/i.test(arg) ? costWeek(d, room) : `Spent today: $${d.spentToday().toFixed(4)} of $${d.dailyCap.toFixed(2)}`;
    case "today":
    case "week":
    case "open":
      return taskList(d, room, name);
    case "undo":
      return undoLast(d.store, d.vikunja, room);
    case "notify-here":
      d.store.setState("notify-room:alerts", room);
      return "Reminders and warnings (Vikunja token rotation, Vikunja unreachable) go to this room from now on.";
    case "releases-here":
      d.store.setState("notify-room:releases", room);
      markAnnounced(d.store, d.version);
      return `Release notes go to this room from now on.\n\n${releaseText(d.version, d.changelog)}`;
    case "project":
      return projectCommand(d, room, arg);
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
const DAY_MS = 86_400_000;
// "2026-10-18" → "Sat 18 Oct"
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

async function taskList(d: CommandDeps, room: string, which: "today" | "week" | "open"): Promise<string> {
  const project = roomProject(d.store, room);
  const now = d.now();
  const today = d.store.today(now);
  const until = which === "today" ? today : which === "week" ? d.store.today(new Date(now.getTime() + 6 * DAY_MS)) : undefined;
  const localDay = (t: Task) => {
    const due = dueOf(t);
    return due ? new Date(due).toLocaleDateString("sv-SE", { timeZone: d.timeZone }) : undefined;
  };
  const picked = (await openTasks(d.vikunja, project?.id))
    .map((t) => ({ t, day: localDay(t) }))
    .filter((x) => !until || (x.day !== undefined && x.day <= until))
    // Overdue first, then by date, undated last
    .sort((a, b) => (a.day ?? "9999").localeCompare(b.day ?? "9999") || a.t.id - b.t.id);

  const scope = project ? `in ${project.title}` : "in all projects";
  const what = which === "today" ? "due today or overdue" : which === "week" ? "due this week or overdue" : "open";
  if (!picked.length) return `Nothing ${what} ${scope}.`;
  const names = project ? undefined : new Map((await d.vikunja.listProjects()).map((p): [number, string] => [p.id, p.title]));
  const lines = picked.slice(0, LIST_LIMIT).map(({ t, day }) => {
    const due = day ? ` · ${day < today ? "**overdue** " : ""}${dayLabel(day)}` : "";
    return `- ${t.title} (#${t.id})${due}${names ? ` · ${names.get(t.project_id) ?? `project ${t.project_id}`}` : ""}`;
  });
  const more = picked.length > LIST_LIMIT ? `\n…and ${picked.length - LIST_LIMIT} more` : "";
  const label = which === "today" ? "Due today or overdue" : which === "week" ? "Due this week or overdue" : "Open tasks";
  return `${label} ${scope}:\n${lines.join("\n")}${more}`;
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
