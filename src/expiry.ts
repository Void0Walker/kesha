import { addDays, type Store } from "./store.ts";
import type { VikunjaApi } from "./vikunja.ts";

// Remind this many days before the token expires, with the reminder task due REMIND_DUE days before
export const REMIND_DAYS = 7;
export const REMIND_DUE = 3;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export interface ExpiryCheck {
  // Token expiry and today, both YYYY-MM-DD
  expires: string;
  today: string;
  store: Store;
  vikunja: VikunjaApi;
  inboxProjectId: number;
  notify(text: string): Promise<void>;
}

/** Runs with the hourly housekeeping; idempotent per expiry date. Creates one rotation task per expiry date in the inbox, and pings the user in Matrix. */
export async function checkTokenExpiry(c: ExpiryCheck): Promise<"ok" | "reminded" | "already-reminded"> {
  const left = daysBetween(c.today, c.expires);
  if (left > REMIND_DAYS) return "ok";
  const key = `rotation-reminder:${c.expires}`;
  if (c.store.getState(key)) return "already-reminded";

  await c.vikunja.createTask(c.inboxProjectId, {
    title: "Rotate Kesha's Vikunja token",
    description:
      `<p>Kesha's Vikunja API token expires on ${c.expires}. Create a new one and swap it in, ` +
      `see the README of the tools repo, "Rotating the Kesha Vikunja token".</p>`,
    due_date: `${addDays(c.expires, -REMIND_DUE)}T12:00:00Z`,
    priority: 3,
  });
  c.store.setState(key, c.today);
  await c.notify(`Heads-up: my Vikunja token expires on ${c.expires} (in ${left} days). I added a task to your inbox to rotate it.`);
  return "reminded";
}
