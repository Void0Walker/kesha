import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTools, htmlToText, runTool, textToHtml, toolDefinitions } from "../src/tools.ts";
import { FakeVikunja } from "./fakes.ts";

const PRIVATE = [{ id: 9, title: "private" }];

const setup = () => {
  const v = new FakeVikunja();
  return { v, tools: createTools(v, 1) };
};

describe("tools", () => {
  it("hides private tasks from lists and counts them", async () => {
    const { v, tools } = setup();
    v.add({ title: "Buy milk" });
    v.add({ title: "Therapy appointment", labels: PRIVATE });
    const { ok, result } = await runTool(tools, "list_tasks", {});
    assert.ok(ok);
    assert.deepEqual((result as any).tasks.map((t: any) => t.title), ["Buy milk"]);
    assert.equal((result as any).hidden_private_tasks, 1);
  });

  it("treats the label case-insensitively", async () => {
    const { v, tools } = setup();
    const t = v.add({ title: "x", labels: [{ id: 9, title: " Private " }] });
    const { ok } = await runTool(tools, "get_task", { id: t.id });
    assert.equal(ok, false);
  });

  it("refuses to read or change a private task, without writing", async () => {
    const { v, tools } = setup();
    const t = v.add({ title: "Therapy appointment", labels: PRIVATE });
    const get = await runTool(tools, "get_task", { id: t.id });
    const upd = await runTool(tools, "update_task", { id: t.id, done: true });
    assert.match(JSON.stringify(get.result), /private/);
    assert.match(JSON.stringify(upd.result), /private/);
    assert.equal(v.writes.length, 0);
    assert.equal(v.tasks.get(t.id)!.done, false);
  });

  it("has no tool that can touch labels", () => {
    const { tools } = setup();
    const schemas = JSON.stringify(toolDefinitions(tools));
    assert.doesNotMatch(schemas, /"labels?"\s*:/);
  });

  it("rejects invalid arguments with a message the model can act on", async () => {
    const { tools } = setup();
    const r = await runTool(tools, "create_task", { title: "", priority: 9, colour: "red" });
    assert.equal(r.ok, false);
    const msg = (r.result as any).error as string;
    assert.match(msg, /title/);
    assert.match(msg, /priority/);
    assert.match(msg, /colour/);
  });

  it("creates in the inbox by default, converting text to HTML and dates to UTC", async () => {
    const { v, tools } = setup();
    const r = await runTool(tools, "create_task", { title: "Call mum", description: "Ask about\nSunday", due_date: "2026-10-10T18:00:00+02:00" });
    assert.ok(r.ok, JSON.stringify(r.result));
    const stored = [...v.tasks.values()][0]!;
    assert.equal(stored.project_id, 1);
    assert.equal(stored.description, "<p>Ask about<br>Sunday</p>");
    assert.equal(stored.due_date, "2026-10-10T16:00:00.000Z");
    assert.equal((r.result as any).description, "Ask about\nSunday");
  });

  it("updates only the given fields and keeps the rest", async () => {
    const { v, tools } = setup();
    const t = v.add({ title: "Buy milk", description: "<p>2 litres</p>", priority: 3 });
    const r = await runTool(tools, "update_task", { id: t.id, done: true });
    assert.ok(r.ok, JSON.stringify(r.result));
    const stored = v.tasks.get(t.id)!;
    assert.deepEqual([stored.done, stored.description, stored.priority], [true, "<p>2 litres</p>", 3]);
  });

  it("clears a due date with null", async () => {
    const { v, tools } = setup();
    const t = v.add({ title: "x", due_date: "2026-10-10T16:00:00Z" });
    const r = await runTool(tools, "update_task", { id: t.id, due_date: null });
    assert.ok(r.ok);
    assert.equal((r.result as any).due_date, undefined);
  });

  it("reports a write that Vikunja didn't store", async () => {
    const { v, tools } = setup();
    const t = v.add({ title: "Buy milk" });
    v.dropOnUpdate = "done";
    const r = await runTool(tools, "update_task", { id: t.id, done: true });
    assert.equal(r.ok, false);
    assert.match((r.result as any).error, /did not store done/);
  });

  it("requires at least one field to update", async () => {
    const { v, tools } = setup();
    const t = v.add({ title: "x" });
    const r = await runTool(tools, "update_task", { id: t.id });
    assert.equal(r.ok, false);
  });

  it("passes Vikunja errors to the model", async () => {
    const { tools } = setup();
    const r = await runTool(tools, "get_task", { id: 404 });
    assert.equal(r.ok, false);
    assert.match((r.result as any).error, /does not exist/);
  });

  it("round-trips descriptions between HTML and text", () => {
    const text = "Line one\nline two\n\nNew <para> & more";
    assert.equal(htmlToText(textToHtml(text)), text);
    assert.equal(htmlToText("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
  });
});

describe("token-lean tool output", () => {
  it("sends schemas without the $schema URL and safe-integer bounds", () => {
    const defs = JSON.stringify(toolDefinitions(createTools(new FakeVikunja(), 1, (t) => [t])));
    assert.doesNotMatch(defs, /\$schema|9007199254740991/);
    assert.match(defs, /"additionalProperties":false/);
  });

  it("leaves default fields out of task summaries", async () => {
    const v = new FakeVikunja();
    v.add({ title: "Plain" });
    v.add({ title: "Busy", priority: 3, due_date: "2026-10-10T16:00:00Z" });
    const r = await runTool(createTools(v, 1, (t) => [t]), "list_tasks", {});
    const tasks = (r.result as { tasks: unknown[] }).tasks;
    assert.deepEqual(tasks[0], { id: 1, title: "Plain", project_id: 1 });
    assert.deepEqual(tasks[1], { id: 2, title: "Busy", due_date: "2026-10-10T16:00:00Z", priority: 3, project_id: 1 });
  });
});
