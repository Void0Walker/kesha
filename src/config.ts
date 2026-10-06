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

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  // Only route to providers that don't store or train on prompts. Narrows the model choice
  OPENROUTER_ZDR: z.stringbool().default(true),
  KESHA_MODEL: z.string().min(1),

  KESHA_MAX_STEPS: z.coerce.number().int().positive().default(8),
  KESHA_MAX_TOKENS: z.coerce.number().int().positive().default(1500),
  // Credits (USD). A request stops calling the model once it has cost this much
  KESHA_MAX_COST_PER_REQUEST: money(0.25),
  // Requests that cost more than this get a warning in the reply
  KESHA_ALERT_COST: money(0.1),
  // No model calls once today's total reaches this
  KESHA_DAILY_COST_CAP: money(1),

  KESHA_PII_FILE: z.string().default("/config/pii.yml"),
  KESHA_DATA_DIR: z.string().default("/data"),
  KESHA_TIMEZONE: z.string().default("Europe/Berlin"),
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
