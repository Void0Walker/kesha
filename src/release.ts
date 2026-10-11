import type { Store } from "./store.ts";

const ANNOUNCED = "announced-version";

/** The changelog section of one version: the lines under "## <version>", up to the next "## ". */
export function releaseNotes(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim() || undefined;
}

export function releaseText(version: string, changelog: string): string {
  const notes = releaseNotes(changelog, version);
  return notes ? `Kesha ${version} is running. What's new:\n${notes}` : `Kesha ${version} is running.`;
}

/** After this, the version isn't announced again on start. */
export function markAnnounced(store: Store, version: string): void {
  store.setState(ANNOUNCED, version);
}

export interface Announcement {
  version: string;
  changelog: string;
  store: Store;
  // Resolves false when there is no room to post to yet
  notify(text: string): Promise<boolean>;
}

/** Runs on start. Posts the release notes once per version, to the release room or the room the user last wrote in. */
export async function announceRelease(a: Announcement): Promise<"announced" | "already-announced" | "no-room"> {
  if (a.store.getState(ANNOUNCED) === a.version) return "already-announced";
  if (!(await a.notify(releaseText(a.version, a.changelog)))) return "no-room";
  markAnnounced(a.store, a.version);
  return "announced";
}
