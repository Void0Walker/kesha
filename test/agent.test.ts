import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent, type Limits } from "../src/agent.ts";
import { Anonymizer, parseDictionary } from "../src/anonymizer.ts";
import { Store } from "../src/store.ts";
import { createTools } from "../src/tools.ts";
import { VikunjaAuthError } from "../src/vikunja.ts";
import { FakeVikunja, say, ScriptedModel, toolCall } from "./fakes.ts";

const DICT = "people:\n  - names: [Jana Nováková, Jana]\n    forms: [Janě, Jany]\n";
const LIMITS: Limits = { maxSteps: 5, maxTokens: 500, maxCostPerRequest: 0.05, alertCost: 0.02, dailyCap: 1 };
const NOW = new Date("2026-10-06T10:00:00Z");

function setup(model: ScriptedModel, limits: Partial<Limits> = {}) {
  const store = new Store(":memory:", "Europe/Berlin");
  const v = new FakeVikunja();
  const anonymizer = new Anonymizer(parseDictionary(DICT), store);
  const agent = new Agent({
    model, modelName: "test/model", tools: createTools(v, 1, (t) => anonymizer.variants(t)), anonymizer,
    store, limits: { ...LIMITS, ...limits }, timeZone: "Europe/Berlin", now: () => NOW,
  });
  return { store, v, agent };
}

describe("agent", () => {
  it("never sends names to the model, and writes the real names to Vikunja", async () => {
    const model = new ScriptedModel([
      toolCall("list_tasks", { search: "<PERSON_1>" }),
      (req) => {
        // The tool result about Jana comes back pseudonymized too
        assert.match(String(req.messages.at(-1)!.content), /<PERSON_1>/);
        return toolCall("create_task", { title: "Call <PERSON_1> about the gift" });
      },
      say("Done, I added a task to call <PERSON_1>."),
    ]);
    const { v, agent } = setup(model);
    v.add({ title: "Gift for Jana", description: "<p>Jany favourite: tea</p>" });

    const res = await agent.turn("thread1", "!room", "Remind me to call Janě about the gift");

    assert.equal(res.reply, "Done, I added a task to call Jana Nováková.");
    assert.doesNotMatch(model.sent(), /Jan[aěy]|Nováková/);
    assert.ok([...v.tasks.values()].some((t) => t.title === "Call Jana Nováková about the gift"));
  });

  it("logs every call with its cost and the pseudonymized request", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects.")], 0.004);
    const { store, agent } = setup(model);
    const res = await agent.turn("t", "!room", "Which projects do I have, Jana?");
    assert.equal(res.cost, 0.008);
    const rows = store.db.prepare("SELECT model, cost, request FROM calls").all() as { model: string; cost: number; request: string }[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.model === "test/model" && r.cost === 0.004));
    assert.doesNotMatch(rows.map((r) => r.request).join(), /Jana/);
    assert.equal(store.spentOn("2026-10-06"), 0.008);
  });

  it("stops calling the model once a request hits its cost cap", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), toolCall("list_projects", {}), say("never reached")], 0.03);
    const { agent } = setup(model);
    const res = await agent.turn("t", "!room", "loop");
    assert.equal(model.requests.length, 2);
    assert.match(res.reply, /cost limit/);
    assert.match(res.alert ?? "", /alert threshold/);
  });

  it("refuses without calling the model once the daily cap is reached", async () => {
    const model = new ScriptedModel([say("never")]);
    const { store, agent } = setup(model, { dailyCap: 0.01 });
    store.logCall({ thread: "x", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.01, request: {}, response: {} }, NOW);
    const res = await agent.turn("t", "!room", "hi");
    assert.equal(model.requests.length, 0);
    assert.match(res.reply, /budget is used up/);
  });

  it("stops after the step limit", async () => {
    const model = new ScriptedModel(Array.from({ length: 5 }, () => toolCall("list_projects", {})), 0);
    const { agent } = setup(model);
    const res = await agent.turn("t", "!room", "loop");
    assert.equal(model.requests.length, 5);
    assert.match(res.reply, /after 5 steps/);
  });

  it("returns tool errors to the model instead of failing", async () => {
    const model = new ScriptedModel([
      toolCall("create_task", { title: "Call <PERSON_9>" }),
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /unknown placeholder/);
        return toolCall("update_task", { id: 1 });
      },
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /at least one field/);
        return say("Sorry.");
      },
    ]);
    const { v, agent } = setup(model);
    const res = await agent.turn("t", "!room", "do it");
    assert.equal(res.reply, "Sorry.");
    assert.equal(v.writes.length, 0);
  });

  it("keeps the conversation per thread, pseudonymized", async () => {
    const model = new ScriptedModel([say("Noted."), say("You asked about <PERSON_1>.")]);
    const { store, agent } = setup(model);
    await agent.turn("t", "!room", "Jana's birthday is soon");
    await agent.turn("t", "!room", "What did I ask?");
    const second = model.requests[1]!.messages.map((m) => m.content);
    assert.deepEqual(second.slice(1), ["<PERSON_1>'s birthday is soon", "Noted.", "What did I ask?"]);
    assert.doesNotMatch(JSON.stringify(store.getHistory("t")), /Jana/);
  });

  it("reports a dead Vikunja token", async () => {
    const model = new ScriptedModel([toolCall("list_tasks", {})]);
    const { v, agent } = setup(model);
    v.listTasks = async () => {
      throw new VikunjaAuthError();
    };
    const res = await agent.turn("t", "!room", "what's open?");
    assert.ok(res.tokenDead);
    assert.match(res.reply, /expired or was revoked/);
  });

  it("forgets idle threads with their mappings", async () => {
    const model = new ScriptedModel([say("ok")]);
    const { store, agent } = setup(model);
    await agent.turn("old", "!room", "Jana");
    assert.equal(store.forgetIdleThreads(1000, NOW.getTime() + 2000), 1);
    assert.equal(store.lookupPlaceholder("old", "<PERSON_1>"), undefined);
  });
});
