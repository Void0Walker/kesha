import { z } from "zod";

const list = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
const money = (fallback: number) => z.coerce.number().positive().default(fallback);

const Env = z.object({
  MATRIX_HOMESERVER_URL: z.url(),
  MATRIX_ACCESS_TOKEN: z.string().min(1),
  // Only these users can talk to Kesha or invite it into rooms
  MATRIX_ALLOWED_USERS: list.pipe(z.array(z.string().regex(/^@[^:]+:.+$/, "expected @user:server")).min(1)),

  VIKUNJA_URL: z.url(),
  VIKUNJA_TOKEN: z.string().min(1),
  // Expiry date of VIKUNJA_TOKEN, drives the rotation reminder
  VIKUNJA_TOKEN_EXPIRES: z.iso.date(),
  // Where new tasks go by default, and where the rotation reminder is created
  VIKUNJA_INBOX_PROJECT_ID: z.coerce.number().int().positive(),
  // Vikunja as the user opens it, for task links in replies. Unset: no links
  VIKUNJA_PUBLIC_URL: z.url().optional(),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  // Only route to providers that don't store or train on prompts. Narrows the model choice
  OPENROUTER_ZDR: z.stringbool().default(true),
  KESHA_MODEL: z.string().min(1),
  // Unset: the model's default. off asks it not to think (on Anthropic models effort turns thinking on)
  KESHA_REASONING_EFFORT: z.enum(["off", "low", "medium", "high"]).optional(),
  // full: cache system prompt and conversation (Anthropic models), system: only the system prompt, off
  KESHA_PROMPT_CACHE: z.enum(["full", "system", "off"]).default("full"),

  KESHA_MAX_STEPS: z.coerce.number().int().positive().default(8),
  KESHA_MAX_TOKENS: z.coerce.number().int().positive().default(1500),
  // Credits (USD). A request stops calling the model once it has cost this much
  KESHA_MAX_COST_PER_REQUEST: money(0.25),
  // Requests that cost more than this get a warning in the reply
  KESHA_ALERT_COST: money(0.1),
  // No model calls once today's total reaches this
  KESHA_DAILY_COST_CAP: money(1),

  // Model for !research threads, needs a ZDR endpoint like KESHA_MODEL. Unset: research is off
  KESHA_RESEARCH_MODEL: z.string().min(1).optional(),
  KESHA_RESEARCH_MAX_STEPS: z.coerce.number().int().positive().default(6),
  KESHA_RESEARCH_MAX_TOKENS: z.coerce.number().int().positive().default(3000),
  KESHA_RESEARCH_MAX_COST_PER_REQUEST: money(0.25),
  // Web searches per research request, over all its model calls
  KESHA_RESEARCH_MAX_SEARCHES: z.coerce.number().int().positive().default(6),
  // Web pages the research model may open per model call (Exa, $0.001 each). 0: search only
  KESHA_RESEARCH_MAX_FETCHES: z.coerce.number().int().nonnegative().default(5),
  KESHA_RESEARCH_REASONING_EFFORT: z.enum(["off", "low", "medium", "high"]).default("medium"),

  // Rooms set with !mode letters. Unset model: the task model, with the letter instructions
  KESHA_LETTERS_MODEL: z.string().min(1).optional(),
  KESHA_LETTERS_MAX_STEPS: z.coerce.number().int().positive().default(4),
  KESHA_LETTERS_MAX_TOKENS: z.coerce.number().int().positive().default(3000),
  KESHA_LETTERS_MAX_COST_PER_REQUEST: money(0.25),
  KESHA_LETTERS_REASONING_EFFORT: z.enum(["off", "low", "medium", "high"]).optional(),
  // Exa through OpenRouter, per search. Added to the cost when OpenRouter's reported cost leaves it out
  KESHA_SEARCH_COST: money(0.007),

  KESHA_PII_FILE: z.string().default("/config/pii.yml"),
  KESHA_DATA_DIR: z.string().default("/data"),
  KESHA_TIMEZONE: z.string().default("Europe/Berlin"),
  // A room's conversation starts over after this many hours of silence
  KESHA_CONVERSATION_IDLE_HOURS: z.coerce.number().positive().default(3),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
