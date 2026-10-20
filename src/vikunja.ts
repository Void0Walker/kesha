export interface Label {
  id: number;
  title: string;
}

/** The fields Kesha reads or writes. Vikunja returns more, those are passed through untouched on update. */
export interface Task {
  id: number;
  title: string;
  description: string;
  done: boolean;
  due_date: string;
  priority: number;
  project_id: number;
  labels: Label[] | null;
  [field: string]: unknown;
}

export interface Project {
  id: number;
  title: string;
  description: string;
  is_archived: boolean;
}

export interface TaskQuery {
  search?: string;
  projectId?: number;
  includeDone?: boolean;
  page?: number;
  perPage?: number;
}

export type TaskChanges = Partial<Pick<Task, "title" | "description" | "done" | "due_date" | "priority" | "project_id">>;

/** What the tools need from Vikunja. Implemented by the HTTP client and by the in-memory fake in tests. */
export interface VikunjaApi {
  listProjects(): Promise<Project[]>;
  listTasks(q: TaskQuery): Promise<Task[]>;
  getTask(id: number): Promise<Task>;
  createTask(projectId: number, fields: TaskChanges & { title: string }): Promise<Task>;
  updateTask(id: number, changes: TaskChanges): Promise<Task>;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** An HTTP error from Vikunja, or (status 0) no answer at all. */
export class VikunjaError extends Error {
  readonly status: number;
  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "VikunjaError";
    this.status = status;
  }
}

/** The token itself no longer works (expired or revoked), as opposed to one endpoint being outside its permissions. */
export class VikunjaAuthError extends VikunjaError {
  constructor() {
    super("Vikunja token expired or revoked", 401);
    this.name = "VikunjaAuthError";
  }
}

// Vikunja's "no date" value
export const NO_DATE = "0001-01-01T00:00:00Z";

export class Vikunja implements VikunjaApi {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.#base = baseUrl.replace(/\/+$/, "") + "/api/v1";
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /** fetch itself failing (connection refused, DNS, the timeout) is a VikunjaError too, with status 0, so a tool call
   * gets an error result the model can tell the user about instead of the whole request failing. */
  async #fetchOrFail(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(this.#base + path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new VikunjaError(timedOut ? `Vikunja did not answer within ${REQUEST_TIMEOUT_MS / 1000} s` : "Vikunja is unreachable", 0, { cause: e });
    }
  }

  async #request<T>(method: string, path: string, body?: unknown, retryAuthCheck = true): Promise<T> {
    const res = await this.#fetchOrFail(path, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    // Vikunja answers 401 both for a dead token and for an endpoint the token has no permission for.
    // Tell them apart with an endpoint the token is always allowed to use.
    if (res.status === 401 && retryAuthCheck) {
      const probe = await this.#fetchOrFail("/projects?per_page=1", { headers: { Authorization: `Bearer ${this.#token}` } });
      if (probe.status === 401) throw new VikunjaAuthError();
      throw new VikunjaError(`Vikunja token has no permission for ${method} ${path.split("?")[0]}`, 403);
    }
    if (res.status === 401) throw new VikunjaAuthError();
    let message = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as { message?: string };
      if (err.message) message = err.message;
    } catch {}
    throw new VikunjaError(`Vikunja: ${message}`, res.status);
  }

  /** Startup check: fails with VikunjaAuthError if the token doesn't work. */
  async check(): Promise<void> {
    await this.#request("GET", "/projects?per_page=1", undefined, false);
  }

  listProjects(): Promise<Project[]> {
    return this.#request("GET", "/projects?per_page=200");
  }

  listTasks(q: TaskQuery): Promise<Task[]> {
    const filters: string[] = [];
    if (!q.includeDone) filters.push("done = false");
    if (q.projectId !== undefined) filters.push(`project = ${q.projectId}`);
    const params = new URLSearchParams({ per_page: String(q.perPage ?? 50), page: String(q.page ?? 1) });
    if (filters.length) params.set("filter", filters.join(" && "));
    if (q.search) params.set("s", q.search);
    return this.#request("GET", `/tasks?${params}`);
  }

  getTask(id: number): Promise<Task> {
    return this.#request("GET", `/tasks/${id}`);
  }

  createTask(projectId: number, fields: TaskChanges & { title: string }): Promise<Task> {
    return this.#request("PUT", `/projects/${projectId}/tasks`, fields);
  }

  /** Vikunja's update replaces the whole task (a missing field is cleared), so read, merge and send everything. */
  async updateTask(id: number, changes: TaskChanges): Promise<Task> {
    const current = await this.getTask(id);
    return this.#request("POST", `/tasks/${id}`, { ...current, ...changes });
  }
}
