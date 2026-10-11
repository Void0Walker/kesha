import { z } from "zod";
import { NO_DATE, VikunjaError, type Task, type TaskChanges, type VikunjaApi } from "./vikunja.ts";

// Tasks with this label never reach OpenRouter. The tools hide them from lists and refuse to read or change them.
// The token could remove the label, so no tool may touch labels at all.
export const PRIVATE_LABEL = "private";

export const isPrivate = (task: Task) =>
  (task.labels ?? []).some((l) => l.title.trim().toLowerCase() === PRIVATE_LABEL);

/** An error the model sees as the tool result and can react to. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const privateRefusal = (id: number) =>
  new ToolError(`Task ${id} is private. Kesha does not read or change private tasks, the user has to handle it in Vikunja.`);

// Descriptions are HTML in Vikunja. The model reads and writes plain text.
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d)>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const dateOrNull = (d: string) => (d === NO_DATE || d.startsWith("0001-") ? null : d);
/** The task's due date, or null when it has none. */
export const dueOf = (t: Task) => dateOrNull(t.due_date);

// Default values are left out (not done, priority 0, no due date, no labels): they were ~40% of a task list's tokens.
// The system prompt tells the model about the defaults
function summarize(t: Task, withDescription = false) {
  const due = dateOrNull(t.due_date);
  const labels = (t.labels ?? []).map((l) => l.title);
  const description = withDescription ? htmlToText(t.description ?? "") : "";
  return {
    id: t.id,
    title: t.title,
    ...(t.done ? { done: true } : {}),
    ...(due ? { due_date: due } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    project_id: t.project_id,
    ...(labels.length ? { labels } : {}),
    ...(description ? { description } : {}),
  };
}

const DueDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "expected an ISO 8601 date or date-time, e.g. 2026-10-10 or 2026-10-10T18:00:00+02:00")
  .describe("ISO 8601 date or date-time with offset");
const Priority = z.number().int().min(0).max(5).describe("0 unset, 1 low, 2 medium, 3 high, 4 urgent, 5 do now");

// The fields Kesha can change, as Vikunja stores them (HTML description, ISO due date). What !undo restores
export const EDITABLE = ["title", "description", "done", "due_date", "priority", "project_id"] as const;
export type TaskFields = Pick<Task, (typeof EDITABLE)[number]>;
export const editableFields = (t: Task): TaskFields =>
  Object.fromEntries(EDITABLE.map((f) => [f, t[f]])) as TaskFields;

export interface ChangeRecord {
  taskId: number;
  kind: "create" | "update";
  // Unset for a created task
  before?: TaskFields;
  after: TaskFields;
}

// Per request: lets the write tools record what they changed, for !undo
export interface ToolContext {
  recordChange?(c: ChangeRecord): void;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export interface OpenTasks {
  tasks: Task[];
  // False when maxPages ran out before the last page: there are more open tasks than listed
  complete: boolean;
}

/** Open tasks, private ones left out, across pages (Vikunja returns at most 50 per page). */
export async function openTasks(vikunja: VikunjaApi, projectId?: number, maxPages = 100): Promise<OpenTasks> {
  const all: Task[] = [];
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const batch = await vikunja.listTasks({ ...(projectId !== undefined ? { projectId } : {}), page, perPage: 50 });
    all.push(...batch);
    if (batch.length < 50) {
      complete = true;
      break;
    }
  }
  return { tasks: all.filter((t) => !t.done && !isPrivate(t)), complete };
}

const tool = <S extends z.ZodType>(t: Tool<S>): Tool => t as unknown as Tool;

// A person's placeholder comes back as their full name, but tasks mention "Jana" or "Jany". Searching for a
// dictionary entry therefore searches each of its spellings.
export type SearchVariants = (term: string) => string[];

export function createTools(vikunja: VikunjaApi, inboxProjectId: number, variants: SearchVariants = (t) => [t]): Tool[] {
  const readable = async (id: number) => {
    const task = await vikunja.getTask(id);
    if (isPrivate(task)) throw privateRefusal(id);
    return task;
  };

  // Read back after every write and compare: the write only counts if Vikunja actually stored it
  const verify = async (id: number, expected: TaskChanges) => {
    const stored = await vikunja.getTask(id);
    const mismatched = Object.entries(expected).filter(([field, value]) => {
      const actual = stored[field];
      if (field === "due_date") return Date.parse(String(actual)) !== Date.parse(String(value));
      if (field === "description") return htmlToText(String(actual ?? "")) !== htmlToText(String(value));
      return actual !== value;
    });
    if (mismatched.length) {
      throw new ToolError(`Vikunja did not store ${mismatched.map(([f]) => f).join(", ")} for task ${id}. Tell the user the change may not have been saved.`);
    }
    return stored;
  };

  const toChanges = (a: { title?: string; description?: string; done?: boolean; due_date?: string | null; priority?: number; project_id?: number }) => {
    const c: TaskChanges = {};
    if (a.title !== undefined) c.title = a.title;
    if (a.description !== undefined) c.description = textToHtml(a.description);
    if (a.done !== undefined) c.done = a.done;
    if (a.due_date !== undefined) c.due_date = a.due_date === null ? NO_DATE : new Date(a.due_date).toISOString();
    if (a.priority !== undefined) c.priority = a.priority;
    if (a.project_id !== undefined) c.project_id = a.project_id;
    return c;
  };

  return [
    tool({
      name: "list_projects",
      description: "List the user's Vikunja projects (id and title). Use it to find a project id by name.",
      schema: z.object({}).strict(),
      async run() {
        const projects = await vikunja.listProjects();
        return projects.filter((p) => !p.is_archived).map((p) => ({ id: p.id, title: p.title }));
      },
    }),
    tool({
      name: "list_tasks",
      description: "List tasks, open ones by default. Optional search (one word, name or placeholder at a time) and project filter. Returns at most 50 per page.",
      schema: z
        .object({
          search: z.string().min(1).optional().describe("full-text search in titles and descriptions"),
          project_id: z.number().int().positive().optional(),
          include_done: z.boolean().optional().describe("also list finished tasks"),
          page: z.number().int().positive().optional(),
        })
        .strict(),
      async run(a) {
        const terms = a.search ? variants(a.search) : [undefined];
        const byId = new Map<number, Task>();
        for (const search of terms) {
          for (const t of await vikunja.listTasks({ search, projectId: a.project_id, includeDone: a.include_done, page: a.page })) byId.set(t.id, t);
        }
        const tasks = [...byId.values()];
        const visible = tasks.filter((t) => !isPrivate(t));
        return { tasks: visible.map((t) => summarize(t)), hidden_private_tasks: tasks.length - visible.length };
      },
    }),
    tool({
      name: "get_task",
      description: "Get one task by id, including its description.",
      schema: z.object({ id: z.number().int().positive() }).strict(),
      async run(a) {
        return summarize(await readable(a.id), true);
      },
    }),
    tool({
      name: "create_task",
      description: `Create a task. Without project_id it goes to the inbox (project ${inboxProjectId}).`,
      schema: z
        .object({
          title: z.string().min(1).max(250),
          description: z.string().max(10_000).optional().describe("plain text"),
          project_id: z.number().int().positive().optional(),
          due_date: DueDate.optional(),
          priority: Priority.optional(),
          done: z.boolean().optional().describe("create it already done, e.g. a recorded decision"),
        })
        .strict(),
      async run(a, ctx) {
        const fields = toChanges(a) as TaskChanges & { title: string };
        const created = await vikunja.createTask(a.project_id ?? inboxProjectId, fields);
        // In case Vikunja ignores done on create
        const final = fields.done && !created.done ? await vikunja.updateTask(created.id, { done: true }) : created;
        ctx.recordChange?.({ taskId: created.id, kind: "create", after: editableFields(final) });
        return summarize(await verify(created.id, fields), true);
      },
    }),
    tool({
      name: "update_task",
      description: "Change fields of a task: title, description, done, due date, priority, or move it to another project. Fields not given stay unchanged. Labels can't be changed.",
      schema: z
        .object({
          id: z.number().int().positive(),
          title: z.string().min(1).max(250).optional(),
          description: z.string().max(10_000).optional().describe("plain text, replaces the whole description"),
          done: z.boolean().optional(),
          due_date: DueDate.nullable().optional().describe("ISO 8601 date or date-time, null removes the due date"),
          priority: Priority.optional(),
          project_id: z.number().int().positive().optional().describe("move the task to this project"),
        })
        .strict()
        .refine((a) => Object.keys(a).length > 1, "give at least one field to change"),
      async run(a, ctx) {
        const { id, ...rest } = a;
        const before = await readable(id);
        const changes = toChanges(rest);
        const updated = await vikunja.updateTask(id, changes);
        // Recorded before verify: a write that verify rejects may still have changed something
        ctx.recordChange?.({ taskId: id, kind: "update", before: editableFields(before), after: editableFields(updated) });
        return summarize(await verify(id, changes), true);
      },
    }),
  ];
}

/** Run a tool call. Every failure becomes a message for the model, except a dead Vikunja token. */
export async function runTool(tools: Tool[], name: string, rawArgs: unknown, ctx: ToolContext = {}): Promise<{ ok: boolean; result: unknown }> {
  const t = tools.find((x) => x.name === name);
  if (!t) return { ok: false, result: { error: `unknown tool ${name}` } };
  const parsed = t.schema.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, result: { error: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` } };
  }
  try {
    return { ok: true, result: await t.run(parsed.data, ctx) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, result: { error: e.message } };
    if (e instanceof VikunjaError && e.name !== "VikunjaAuthError") return { ok: false, result: { error: e.message } };
    throw e;
  }
}

/** zod's JSON Schema without what costs tokens on every call and tells the model nothing: the $schema URL and the
 * safe-integer bounds of .int(). */
function leanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(leanSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k, v]) => k !== "$schema" && !((k === "maximum" || k === "minimum") && Math.abs(v as number) === Number.MAX_SAFE_INTEGER))
      .map(([k, v]) => [k, leanSchema(v)]),
  );
}

export function toolDefinitions(tools: Tool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: leanSchema(z.toJSONSchema(t.schema)) as Record<string, unknown> },
  }));
}
