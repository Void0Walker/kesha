import type { Store } from "./store.ts";

const STATE_KEY = "announced-version";

/** The changelog section of one version: the lines under "## <version>", up to the next "## ". */
export function releaseNotes(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim() || undefined;
}

export interface Announcement {
  version: string;
  changelog: string;
  store: Store;
  // Resolves false when there is no room to post to yet
  notify(text: string): Promise<boolean>;
}

/** Runs on start. Posts the release notes once per version, to the room the user last wrote in. */
export async function announceRelease(a: Announcement): Promise<"announced" | "already-announced" | "no-room"> {
  if (a.store.getState(STATE_KEY) === a.version) return "already-announced";
  const notes = releaseNotes(a.changelog, a.version);
  if (!(await a.notify(notes ? `Kesha ${a.version} is running. What's new:\n${notes}` : `Kesha ${a.version} is running.`))) {
    return "no-room";
  }
  a.store.setState(STATE_KEY, a.version);
  return "announced";
}
