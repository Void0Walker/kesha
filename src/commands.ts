import { markAnnounced, releaseText } from "./release.ts";
import type { Store } from "./store.ts";
import type { Project } from "./vikunja.ts";

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

export const HELP = [
  "Write to me in plain language about your tasks. Each top-level message starts a conversation, reply in its thread to continue it.",
  "!research <question>: research thread with web search",
  "!project <name>: new tasks in this room go to that project. !project shows it, !project none removes it",
  "!notify-here: reminders and warnings go to this room",
  "!releases-here: release notes go to this room",
  "!cost: today's spend",
  "!help: this list",
].join("\n");

export interface CommandDeps {
  store: Store;
  listProjects(): Promise<Project[]>;
  spentToday(): number;
  dailyCap: number;
  version: string;
  changelog: string;
}

/** Returns the reply, or undefined when the message is not a command (or is !research, which goes to the agent). */
export async function runCommand(d: CommandDeps, room: string, body: string): Promise<string | undefined> {
  const m = /^!([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(body);
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  switch (name) {
    case "research":
      return undefined;
    case "help":
      return HELP;
    case "cost":
      return `Spent today: $${d.spentToday().toFixed(4)} of $${d.dailyCap.toFixed(2)}`;
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
      return `I don't know !${name}.\n\n${HELP}`;
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

  const projects = (await d.listProjects()).filter((p) => !p.is_archived);
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
