import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LogLevel, LogService } from "matrix-bot-sdk";
import { Agent } from "./agent.ts";
import { Anonymizer, parseDictionary } from "./anonymizer.ts";
import { loadConfig } from "./config.ts";
import { checkTokenExpiry } from "./expiry.ts";
import { OpenRouter } from "./llm.ts";
import { Bot } from "./matrix.ts";
import { announceRelease } from "./release.ts";
import { Store } from "./store.ts";
import { createTools } from "./tools.ts";
import { Vikunja, VikunjaAuthError } from "./vikunja.ts";

const IDLE_THREAD_MS = 30 * 86_400_000;
const CALL_BODIES_MS = 30 * 86_400_000;
const HOUSEKEEPING_MS = 6 * 3_600_000;

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
const vikunja = new Vikunja(config.VIKUNJA_URL, config.VIKUNJA_TOKEN);
try {
  await vikunja.check();
} catch (e) {
  console.error(e instanceof VikunjaAuthError ? "startup check: Vikunja token expired or revoked" : `startup check: Vikunja unreachable: ${e}`);
  process.exit(1);
}
console.log("vikunja: token works");
console.log(`models: ${config.KESHA_MODEL}, research ${config.KESHA_RESEARCH_MODEL ?? "off"}`);

const anonymizer = new Anonymizer(dictionary, store);
const agent = new Agent({
  model: new OpenRouter({
    apiKey: config.OPENROUTER_API_KEY, baseURL: config.OPENROUTER_BASE_URL, zdr: config.OPENROUTER_ZDR,
    searchCost: config.KESHA_SEARCH_COST, promptCache: config.KESHA_PROMPT_CACHE,
  }),
  modelName: config.KESHA_MODEL,
  ...(config.KESHA_RESEARCH_MODEL
    ? {
        research: {
          modelName: config.KESHA_RESEARCH_MODEL,
          maxSteps: config.KESHA_RESEARCH_MAX_STEPS,
          maxTokens: config.KESHA_RESEARCH_MAX_TOKENS,
          maxCostPerRequest: config.KESHA_RESEARCH_MAX_COST_PER_REQUEST,
          maxSearches: config.KESHA_RESEARCH_MAX_SEARCHES,
          reasoning: config.KESHA_RESEARCH_REASONING_EFFORT,
        },
      }
    : {}),
  tools: createTools(vikunja, config.VIKUNJA_INBOX_PROJECT_ID, (term) => anonymizer.variants(term)),
  anonymizer,
  store,
  limits: {
    maxSteps: config.KESHA_MAX_STEPS,
    maxTokens: config.KESHA_MAX_TOKENS,
    maxCostPerRequest: config.KESHA_MAX_COST_PER_REQUEST,
    alertCost: config.KESHA_ALERT_COST,
    dailyCap: config.KESHA_DAILY_COST_CAP,
    ...(config.KESHA_REASONING_EFFORT ? { reasoning: config.KESHA_REASONING_EFFORT } : {}),
  },
  timeZone: config.KESHA_TIMEZONE,
});

const bot = new Bot({
  homeserverUrl: config.MATRIX_HOMESERVER_URL,
  accessToken: config.MATRIX_ACCESS_TOKEN,
  allowedUsers: config.MATRIX_ALLOWED_USERS,
  dataDir: config.KESHA_DATA_DIR,
  agent,
  store,
  listProjects: () => vikunja.listProjects(),
  version,
  changelog,
});
await bot.start();
try {
  if ((await announceRelease({ version, changelog, store, notify: (t) => bot.notify(t, "releases") })) === "announced") console.log(`announced ${version}`);
} catch (e) {
  console.error("release announcement failed:", e);
}

async function housekeeping() {
  const forgotten = store.forgetIdleThreads(IDLE_THREAD_MS);
  if (forgotten) console.log(`pii: forgot ${forgotten} idle thread(s)`);
  const blanked = store.pruneCallBodies(CALL_BODIES_MS);
  if (blanked) console.log(`calls: blanked ${blanked} request bodies older than 30 days`);
  try {
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
      console.error("housekeeping failed:", e);
    }
  }
}
await housekeeping();
setInterval(() => void housekeeping(), HOUSEKEEPING_MS);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    bot.stop();
    store.db.close();
    process.exit(0);
  });
}
