import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LogLevel, LogService } from "matrix-bot-sdk";
import { Agent } from "./agent.ts";
import { Anonymizer, parseDictionary } from "./anonymizer.ts";
import { loadConfig } from "./config.ts";
import { describeError, PastError } from "./errors.ts";
import { checkTokenExpiry } from "./expiry.ts";
import { OpenRouter } from "./llm.ts";
import { Bot } from "./matrix.ts";
import { activeConversations } from "./conversation.ts";
import { announceRelease } from "./release.ts";
import { Store } from "./store.ts";
import { createTools, openTasks } from "./tools.ts";
import { Vikunja, VikunjaAuthError } from "./vikunja.ts";

const IDLE_THREAD_MS = 30 * 86_400_000;
// Ended conversations (after !new or a quiet period) are never read again: forget them, with their mappings, soon
const ENDED_CONVERSATION_MS = 3_600_000;
const CALL_BODIES_MS = 30 * 86_400_000;
// !undo works on the last week; the change log holds real task text
const CHANGES_MS = 7 * 86_400_000;
const HOUSEKEEPING_MS = 3_600_000;

const config = loadConfig();
const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
console.log(`kesha ${version}`);
// Release notes, posted to the chat when a new version starts and by !releases-here
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
LogService.setLevel(LogLevel.WARN);
mkdirSync(config.KESHA_DATA_DIR, { recursive: true });

// No dictionary, no start: running without it would send known names to the provider
const dictionary = parseDictionary(readFileSync(config.KESHA_PII_FILE, "utf8"));
console.log(`pii: ${dictionary.length} dictionary entries`);

const store = new Store(join(config.KESHA_DATA_DIR, "kesha.sqlite"), config.KESHA_TIMEZONE);

// A crash can't be reported while it happens: it's kept and reported by the next start, once Matrix is up
const CRASH_KEY = "last-crash";
function crash(what: string, e: unknown): never {
  console.error(`${what}:`, e);
  try {
    store.setState(CRASH_KEY, JSON.stringify({ what, error: describeError(e) }));
  } catch {}
  process.exit(1);
}
process.on("uncaughtException", (e) => crash("Crashed", e));
process.on("unhandledRejection", (e) => crash("Crashed on an unhandled rejection", e));

const vikunja = new Vikunja(config.VIKUNJA_URL, config.VIKUNJA_TOKEN);
try {
  await vikunja.check();
} catch (e) {
  crash(e instanceof VikunjaAuthError ? "Startup check: Vikunja token expired or revoked" : "Startup check: Vikunja unreachable", e);
}
console.log("vikunja: token works");
console.log(`models: ${config.KESHA_MODEL}, research ${config.KESHA_RESEARCH_MODEL ?? "off"}, letters ${config.KESHA_LETTERS_MODEL ?? config.KESHA_MODEL}`);

const anonymizer = new Anonymizer(dictionary, store);
const agent = new Agent({
  model: new OpenRouter({
    apiKey: config.OPENROUTER_API_KEY, baseURL: config.OPENROUTER_BASE_URL, zdr: config.OPENROUTER_ZDR,
    searchCost: config.KESHA_SEARCH_COST, promptCache: config.KESHA_PROMPT_CACHE,
  }),
  task: {
    modelName: config.KESHA_MODEL,
    maxSteps: config.KESHA_MAX_STEPS,
    maxTokens: config.KESHA_MAX_TOKENS,
    maxCostPerRequest: config.KESHA_MAX_COST_PER_REQUEST,
    maxSearches: 0,
    ...(config.KESHA_REASONING_EFFORT ? { reasoning: config.KESHA_REASONING_EFFORT } : {}),
  },
  letters: {
    modelName: config.KESHA_LETTERS_MODEL ?? config.KESHA_MODEL,
    maxSteps: config.KESHA_LETTERS_MAX_STEPS,
    maxTokens: config.KESHA_LETTERS_MAX_TOKENS,
    maxCostPerRequest: config.KESHA_LETTERS_MAX_COST_PER_REQUEST,
    maxSearches: 0,
    ...(config.KESHA_LETTERS_REASONING_EFFORT ? { reasoning: config.KESHA_LETTERS_REASONING_EFFORT } : {}),
  },
  ...(config.KESHA_RESEARCH_MODEL
    ? {
        research: {
          modelName: config.KESHA_RESEARCH_MODEL,
          maxSteps: config.KESHA_RESEARCH_MAX_STEPS,
          maxTokens: config.KESHA_RESEARCH_MAX_TOKENS,
          maxCostPerRequest: config.KESHA_RESEARCH_MAX_COST_PER_REQUEST,
          maxSearches: config.KESHA_RESEARCH_MAX_SEARCHES,
          maxFetches: config.KESHA_RESEARCH_MAX_FETCHES,
          reasoning: config.KESHA_RESEARCH_REASONING_EFFORT,
        },
      }
    : {}),
  tools: createTools(vikunja, { inboxProjectId: config.VIKUNJA_INBOX_PROJECT_ID, variants: (term) => anonymizer.variants(term), timeZone: config.KESHA_TIMEZONE }),
  // Two pages are plenty for the 30 tasks shown, and keep the snapshot to at most two requests
  listOpenTasks: async (projectId) => (await openTasks(vikunja, projectId, 2)).tasks,
  anonymizer,
  store,
  limits: { alertCost: config.KESHA_ALERT_COST, dailyCap: config.KESHA_DAILY_COST_CAP },
  timeZone: config.KESHA_TIMEZONE,
});

const bot = new Bot({
  homeserverUrl: config.MATRIX_HOMESERVER_URL,
  accessToken: config.MATRIX_ACCESS_TOKEN,
  allowedUsers: config.MATRIX_ALLOWED_USERS,
  dataDir: config.KESHA_DATA_DIR,
  agent,
  store,
  vikunja,
  timeZone: config.KESHA_TIMEZONE,
  version,
  changelog,
  idleMs: config.KESHA_CONVERSATION_IDLE_HOURS * 3_600_000,
  format: config.VIKUNJA_PUBLIC_URL ? { vikunjaUrl: config.VIKUNJA_PUBLIC_URL } : {},
});
await bot.start();
const lastCrash = store.getState(CRASH_KEY);
if (lastCrash) {
  store.deleteState(CRASH_KEY);
  const { what, error } = JSON.parse(lastCrash) as { what: string; error: string };
  await bot.failed(`${what}, then restarted`, new PastError(error));
}
try {
  if ((await announceRelease({ version, changelog, store, notify: (t) => bot.notify(t, "releases") })) === "announced") console.log(`announced ${version}`);
} catch (e) {
  await bot.failed("Release announcement failed", e);
}

// Hourly. Nothing in here may take the process down: a failure is reported and tried again next hour
async function housekeeping() {
  try {
    const forgotten = store.forgetIdleThreads(IDLE_THREAD_MS);
    const ended = store.forgetEndedConversations(activeConversations(store), ENDED_CONVERSATION_MS);
    if (forgotten + ended) console.log(`pii: forgot ${forgotten + ended} conversation(s)`);
    store.pruneChanges(CHANGES_MS);
    const blanked = store.pruneCallBodies(CALL_BODIES_MS);
    if (blanked) console.log(`calls: blanked ${blanked} request bodies older than 30 days`);
    const r = await checkTokenExpiry({
      expires: config.VIKUNJA_TOKEN_EXPIRES,
      today: store.today(),
      store,
      vikunja,
      inboxProjectId: config.VIKUNJA_INBOX_PROJECT_ID,
      notify: async (text) => void (await bot.notify(text)),
    });
    if (r === "reminded") console.log("vikunja: token rotation reminder created");
  } catch (e) {
    if (e instanceof VikunjaAuthError) {
      bot.setVikunjaDown(true);
      console.error("vikunja: token expired or revoked");
      await bot.notify("My Vikunja token expired or was revoked. Rotate it (README, \"Rotating the Kesha Vikunja token\").").catch(() => {});
    } else {
      await bot.failed("Housekeeping failed", e);
    }
  }
}
await housekeeping();
setInterval(() => void housekeeping(), HOUSEKEEPING_MS);

// Docker gives 10 s: stop taking messages, let the requests in flight send their replies, then close the database
const DRAIN_MS = 8_000;
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    bot.stop();
    void bot.drain(DRAIN_MS).then((pending) => {
      if (pending) console.warn(`stopped with ${pending} request(s) still running`);
      store.db.close();
      process.exit(0);
    });
  });
}
