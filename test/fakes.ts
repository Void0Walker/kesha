import type { ChatModel, Completion, CompletionRequest } from "../src/llm.ts";
import { NO_DATE, VikunjaError, type Project, type Task, type TaskChanges, type TaskQuery, type VikunjaApi } from "../src/vikunja.ts";

/** In-memory Vikunja with the real API's quirks that matter: updates replace the whole task. Fictional data only. */
export class FakeVikunja implements VikunjaApi {
  projects: Project[] = [
    { id: 1, title: "Inbox", description: "", is_archived: false },
    { id: 2, title: "Groceries", description: "", is_archived: false },
  ];
  tasks = new Map<number, Task>();
  writes: { op: string; id?: number; body: unknown }[] = [];
  // Set to make the next update silently drop a field, like a misbehaving server
  dropOnUpdate?: keyof TaskChanges;
  #nextId = 1;

  add(fields: Partial<Task> & { title: string }): Task {
    const t: Task = {
      id: this.#nextId++, description: "", done: false, due_date: NO_DATE, priority: 0, project_id: 1, labels: null,
      ...fields,
    };
    this.tasks.set(t.id, t);
    return t;
  }

  async listProjects() {
    return this.projects;
  }

  async listTasks(q: TaskQuery) {
    const perPage = q.perPage ?? 50;
    const page = q.page ?? 1;
    return [...this.tasks.values()]
      .filter(
        (t) =>
          (q.includeDone || !t.done) &&
          (q.projectId === undefined || t.project_id === q.projectId) &&
          (!q.search || `${t.title} ${t.description}`.toLowerCase().includes(q.search.toLowerCase())),
      )
      .slice((page - 1) * perPage, page * perPage);
  }

  async getTask(id: number) {
    const t = this.tasks.get(id);
    if (!t) throw new VikunjaError("Vikunja: The task does not exist.", 404);
    return structuredClone(t);
  }

  async createTask(projectId: number, fields: TaskChanges & { title: string }) {
    this.writes.push({ op: "create", body: { projectId, ...fields } });
    return this.add({ ...fields, project_id: projectId });
  }

  async updateTask(id: number, changes: TaskChanges) {
    this.writes.push({ op: "update", id, body: changes });
    const current = await this.getTask(id);
    const next = { ...current, ...changes };
    if (this.dropOnUpdate) next[this.dropOnUpdate] = current[this.dropOnUpdate] as never;
    this.tasks.set(id, next);
    return next;
  }
}

type Reply = Partial<Completion> & { message: Completion["message"] };
// A canned reply, or a function that can assert on the request first
type Step = Reply | ((req: CompletionRequest) => Reply);

/** Model that plays back scripted steps and records every request, to assert on what would leave the server. */
export class ScriptedModel implements ChatModel {
  requests: CompletionRequest[] = [];
  readonly #steps: Step[];
  readonly #costPerCall: number;

  constructor(steps: Step[], costPerCall = 0.001) {
    this.#steps = steps;
    this.#costPerCall = costPerCall;
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    this.requests.push(structuredClone(req));
    const step = this.#steps[this.requests.length - 1];
    if (!step) throw new Error(`ScriptedModel: no step ${this.requests.length}`);
    const reply = typeof step === "function" ? step(req) : step;
    return { model: req.model, promptTokens: 10, completionTokens: 5, cost: this.#costPerCall, searches: 0, fetches: 0, citations: [], cachedTokens: 0, reasoningTokens: 0, ...reply };
  }

  /** Everything that was sent, as one string, for leak checks. */
  sent(): string {
    return JSON.stringify(this.requests);
  }
}

export const toolCall = (name: string, args: unknown, id = `call_${name}`) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
  },
});

export const say = (content: string) => ({ message: { role: "assistant" as const, content } });
