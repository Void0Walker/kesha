import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Vikunja, VikunjaAuthError, VikunjaError } from "../src/vikunja.ts";

type Handler = (method: string, path: string, body: unknown) => { status: number; json?: unknown };

function fakeFetch(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace("/api/v1", "") + new URL(url).search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body });
    const r = handler(init.method ?? "GET", path, body);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("vikunja client", () => {
  it("sends the whole task on update, because Vikunja clears missing fields", async () => {
    const task = { id: 5, title: "Buy milk", description: "<p>2 litres</p>", priority: 3, done: false, extra: "kept" };
    const { f, calls } = fakeFetch((m, _p, body) => (m === "GET" ? { status: 200, json: task } : { status: 200, json: body }));
    await new Vikunja("https://plans.example", "tk", f).updateTask(5, { done: true });
    const post = calls.find((c) => c.method === "POST")!;
    assert.equal(post.path, "/tasks/5");
    assert.deepEqual(post.body, { ...task, done: true });
  });

  it("builds the task filter", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, json: [] }));
    await new Vikunja("https://plans.example/", "tk", f).listTasks({ search: "milk", projectId: 2 });
    const params = new URLSearchParams(calls[0]!.path.split("?")[1]);
    assert.equal(params.get("filter"), "done = false && project = 2");
    assert.equal(params.get("s"), "milk");
  });

  it("tells a dead token from a missing permission", async () => {
    const dead = fakeFetch(() => ({ status: 401, json: { message: "invalid token" } }));
    await assert.rejects(new Vikunja("https://p.example", "tk", dead.f).getTask(1), VikunjaAuthError);

    const scoped = fakeFetch((_m, p) => (p.startsWith("/projects") ? { status: 200, json: [] } : { status: 401 }));
    await assert.rejects(new Vikunja("https://p.example", "tk", scoped.f).getTask(1), (e) => {
      return e instanceof VikunjaError && !(e instanceof VikunjaAuthError) && /no permission/.test(e.message);
    });
  });

  it("fails the startup check on a dead token", async () => {
    const dead = fakeFetch(() => ({ status: 401 }));
    await assert.rejects(new Vikunja("https://p.example", "tk", dead.f).check(), VikunjaAuthError);
  });

  it("surfaces Vikunja's error message", async () => {
    const { f } = fakeFetch(() => ({ status: 404, json: { message: "The task does not exist." } }));
    await assert.rejects(new Vikunja("https://p.example", "tk", f).getTask(1), /The task does not exist/);
  });
});
