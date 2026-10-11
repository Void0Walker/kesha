import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent, compactHistory, costFooter, sentAt, trimHistory, type Limits, type ResearchProfile } from "../src/agent.ts";
import type { Message } from "../src/llm.ts";
import { Anonymizer, parseDictionary } from "../src/anonymizer.ts";
import { Store } from "../src/store.ts";
import { createTools } from "../src/tools.ts";
import { VikunjaAuthError } from "../src/vikunja.ts";
import { FakeVikunja, say, ScriptedModel, toolCall } from "./fakes.ts";

const DICT = "people:\n  - names: [Jana Nováková, Jana]\n    forms: [Janě, Jany]\n";
const LIMITS: Limits = { maxSteps: 5, maxTokens: 500, maxCostPerRequest: 0.05, alertCost: 0.02, dailyCap: 1 };
const NOW = new Date("2026-10-06T10:00:00Z");

const RESEARCH: ResearchProfile = { modelName: "test/research", maxSteps: 4, maxTokens: 2000, maxCostPerRequest: 0.2, maxSearches: 3 };

function setup(model: ScriptedModel, limits: Partial<Limits> = {}, research?: ResearchProfile) {
  const store = new Store(":memory:", "Europe/Berlin");
  const v = new FakeVikunja();
  const anonymizer = new Anonymizer(parseDictionary(DICT), store);
  const agent = new Agent({
    model, modelName: "test/model", tools: createTools(v, 1, (t) => anonymizer.variants(t)), anonymizer,
    store, limits: { ...LIMITS, ...limits }, timeZone: "Europe/Berlin", now: () => NOW, ...(research ? { research } : {}),
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

  it("refuses to write the provider's redaction labels into Vikunja", async () => {
    const model = new ScriptedModel([
      toolCall("create_task", { title: "Call [PERSON_NAME] at [PHONE]" }),
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /\[PERSON_NAME\], \[PHONE\] was removed by the provider/);
        return toolCall("update_task", { id: 1, description: "Notes: [SECRET:github-token]" });
      },
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /\[SECRET:github-token\] was removed/);
        return say("I couldn't see the name, please tell me who to call.");
      },
    ]);
    const { v, agent } = setup(model);
    v.add({ title: "Existing" });
    const res = await agent.turn("t", "!room", "add a task");
    assert.equal(v.writes.length, 0);
    assert.match(res.reply, /couldn't see the name/);
  });

  it("still writes square brackets that aren't redaction labels", async () => {
    const model = new ScriptedModel([toolCall("create_task", { title: "[WIP] Fix bike" }), say("Added.")]);
    const { v, agent } = setup(model);
    await agent.turn("t", "!room", "add [WIP] Fix bike");
    assert.equal(v.writes.length, 1);
  });

  it("keeps the conversation per thread, pseudonymized", async () => {
    const model = new ScriptedModel([say("Noted."), say("You asked about <PERSON_1>.")]);
    const { store, agent } = setup(model);
    await agent.turn("t", "!room", "Jana's birthday is soon");
    await agent.turn("t", "!room", "What did I ask?");
    const second = model.requests[1]!.messages.map((m) => m.content);
    const at = "[Tue 2026-10-06 12:00 +02:00]";
    assert.deepEqual(second.slice(1), [`${at} <PERSON_1>'s birthday is soon`, "Noted.", `${at} What did I ask?`]);
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

describe("research", () => {
  it("uses the research model with web search, lists sources and counts searches", async () => {
    const model = new ScriptedModel([
      (req) => {
        assert.equal(req.model, "test/research");
        assert.deepEqual(req.webSearch, { maxSearches: 3 });
        assert.match(String(req.messages[0]!.content), /search the web/);
        return {
          ...say("Node 24 is the current LTS, supported until April 2028."), searches: 2, cost: 0.02,
          citations: [{ url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases" }, { url: "https://example.org/eol" }],
        };
      },
    ]);
    const { agent } = setup(model, {}, RESEARCH);
    const res = await agent.turn("t", "!room", "Which Node.js version is LTS?", "research");
    assert.equal(res.reply, [
      "Node 24 is the current LTS, supported until April 2028.",
      "",
      "Sources:",
      "1. Node.js Releases — https://nodejs.org/en/about/previous-releases",
      "2. https://example.org/eol",
    ].join("\n"));
    assert.equal(res.searches, 2);
    assert.equal(res.footer, "— $0.0200 · 2 searches · today $0.0200 of $1.00");
  });

  it("stops offering web search once the request used its searches", async () => {
    const model = new ScriptedModel([
      { ...toolCall("list_projects", {}), searches: 3 },
      (req) => {
        assert.equal(req.webSearch, undefined);
        return say("Done.");
      },
    ]);
    const { agent } = setup(model, {}, RESEARCH);
    const res = await agent.turn("t", "!room", "dig deep", "research");
    assert.equal(res.searches, 3);
  });

  it("applies the research cost cap instead of the task one", async () => {
    // 0.06 per call is over the task cap (0.05) after one call, and over the research cap (0.2) after the fourth
    const model = new ScriptedModel(Array.from({ length: 6 }, () => toolCall("list_projects", {})), 0.06);
    const { agent } = setup(model, {}, { ...RESEARCH, maxSteps: 6 });
    const res = await agent.turn("t", "!room", "loop", "research");
    assert.equal(model.requests.length, 4);
    assert.match(res.reply, /cost limit of \$0\.2000/);
  });

  it("never offers web search in task threads", async () => {
    const model = new ScriptedModel([(req) => (assert.equal(req.webSearch, undefined), say("ok"))]);
    const { agent } = setup(model, {}, RESEARCH);
    await agent.turn("t", "!room", "hi");
  });

  it("says so when research is not configured", async () => {
    const model = new ScriptedModel([]);
    const { agent } = setup(model);
    const res = await agent.turn("t", "!room", "anything", "research");
    assert.equal(model.requests.length, 0);
    assert.match(res.reply, /KESHA_RESEARCH_MODEL/);
    assert.equal(res.footer, undefined);
  });

  it("forgets the mode of idle threads", async () => {
    const { store, agent } = setup(new ScriptedModel([say("ok")]), {}, RESEARCH);
    store.setThreadMode("old", "research");
    await agent.turn("old", "!room", "hi", "research");
    store.forgetIdleThreads(1000, NOW.getTime() + 2000);
    assert.equal(store.threadMode("old"), undefined);
  });
});

describe("decisions", () => {
  it("records a decision as an open task in the room's project", async () => {
    const model = new ScriptedModel([
      (req) => {
        assert.match(String(req.messages[0]!.content), /note or record a decision, create one open task \(not done\)/);
        return toolCall("create_task", { title: "Decision: Bosch dishwasher", description: "Quieter, fits the niche. Ruled out: Miele (price). 2026-10-06" });
      },
      say("Noted the decision."),
    ]);
    const { v, agent } = setup(model);
    await agent.turn("t", "!room", "note that decision", "task", { id: 2, title: "Home appliances" });
    const task = [...v.tasks.values()].find((t) => t.title === "Decision: Bosch dishwasher")!;
    assert.equal(task.done, false);
    assert.equal(task.project_id, 2);
  });

  it("creates a task as done when asked, also when Vikunja ignores done on create", async () => {
    const model = new ScriptedModel([toolCall("create_task", { title: "Paid the electricity bill", done: true }), say("Logged.")]);
    const { v, agent } = setup(model);
    const create = v.createTask.bind(v);
    v.createTask = (pid, fields) => create(pid, { ...fields, done: false });
    await agent.turn("t", "!room", "log that I already paid the electricity bill");
    assert.equal([...v.tasks.values()][0]!.done, true);
  });
});

describe("room project", () => {
  it("puts new tasks into the room's project unless the model names one, and pseudonymizes its title", async () => {
    const model = new ScriptedModel([
      (req) => {
        assert.match(String(req.messages[0]!.content), /belongs to the project "<PERSON_1>'s room" \(id 2\)/);
        return toolCall("create_task", { title: "Descale kettle" });
      },
      toolCall("create_task", { title: "Pay rent", project_id: 1 }, "call_2"),
      say("Done."),
    ]);
    const { v, agent } = setup(model);
    await agent.turn("t", "!room", "add two tasks", "task", { id: 2, title: "Jana's room" });
    assert.deepEqual(v.writes.map((w) => (w.body as { projectId: number }).projectId), [2, 1]);
    assert.doesNotMatch(model.sent(), /Jana/);
  });
});

describe("cost footer", () => {
  it("shows the request cost and today's total on task replies", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects.")], 0.004);
    const { store, agent } = setup(model);
    store.logCall({ thread: "x", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.1, request: {}, response: {} }, NOW);
    const res = await agent.turn("t", "!room", "Which projects?");
    assert.equal(res.footer, "— $0.0080 · today $0.1080 of $1.00");
  });

  it("formats one search in the singular", () => {
    assert.equal(costFooter(0.0134, 1, 0.5, 2), "— $0.0134 · 1 search · today $0.5000 of $2.00");
  });
});

describe("token savings", () => {
  it("sends byte-identical system prompts and the same session id in every call of a conversation", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects (#1, #2)."), say("Sure.")]);
    const { agent } = setup(model);
    await agent.turn("t", "!room", "Which projects, Jana?");
    await agent.turn("t", "!room", "thanks");
    const systems = new Set(model.requests.map((r) => JSON.stringify(r.messages[0])));
    assert.equal(systems.size, 1);
    assert.doesNotMatch([...systems][0]!, /2026-10-06|Now:/);
    const sessions = new Set(model.requests.map((r) => r.sessionId));
    assert.equal(sessions.size, 1);
    assert.match([...sessions][0]!, /^[0-9a-f]{32}$/);
  });

  it("drops earlier tool calls and results from later turns", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects."), say("ok")]);
    const { store, agent } = setup(model);
    await agent.turn("t", "!room", "Which projects?");
    await agent.turn("t", "!room", "and now?");
    const roles = model.requests[2]!.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
    assert.ok((store.getHistory("t") as Message[]).every((m) => m.role !== "tool"));
  });

  it("replaces an empty reply instead of storing an empty assistant message", async () => {
    const model = new ScriptedModel([say("")]);
    const { store, agent } = setup(model);
    const res = await agent.turn("t", "!room", "hi");
    assert.match(res.reply, /no answer/);
    const last = (store.getHistory("t") as Message[]).at(-1)!;
    assert.equal(last.role, "assistant");
    assert.match(String(last.content), /no answer/);
  });

  it("keeps the start of the history stable until it is twice the trim size", () => {
    const pair = (i: number): Message[] => [{ role: "user", content: `q${i} ${"x".repeat(1000)}` }, { role: "assistant", content: `a${i}` }];
    const small = Array.from({ length: 10 }, (_, i) => pair(i)).flat();
    assert.equal(trimHistory(small), small);
    const big = Array.from({ length: 30 }, (_, i) => pair(i)).flat();
    const trimmed = trimHistory(big);
    assert.equal(trimmed[0]!.role, "user");
    assert.ok(JSON.stringify(trimmed).length <= 12_000);
    assert.equal(trimmed.at(-1), big.at(-1));
  });

  it("removes reasoning from stored replies", () => {
    const h = [{ role: "assistant", content: "ok", reasoning_details: [{ type: "x" }] }] as unknown as Message[];
    assert.deepEqual(compactHistory(h), [{ role: "assistant", content: "ok" }]);
  });

  it("stamps user messages with weekday, local time and offset", () => {
    assert.equal(sentAt(new Date("2026-12-24T17:30:00Z"), "Europe/Berlin"), "Thu 2026-12-24 18:30 +01:00");
    assert.equal(sentAt(new Date("2026-10-06T10:00:00Z"), "UTC"), "Tue 2026-10-06 10:00 +00:00");
  });
});
