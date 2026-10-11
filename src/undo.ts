import type { Store } from "./store.ts";
import { EDITABLE, editableFields, htmlToText, isPrivate, type TaskFields } from "./tools.ts";
import type { VikunjaApi } from "./vikunja.ts";

const LABEL: Record<(typeof EDITABLE)[number], string> = {
  title: "title", description: "description", done: "done", due_date: "due date", priority: "priority", project_id: "project",
};

const same = (field: (typeof EDITABLE)[number], a: unknown, b: unknown) =>
  field === "due_date" ? Date.parse(String(a)) === Date.parse(String(b))
    : field === "description" ? htmlToText(String(a ?? "")) === htmlToText(String(b ?? ""))
    : a === b;

/** Fields that differ between what Kesha left behind and what the task is now. */
function drift(after: TaskFields, now: TaskFields): string[] {
  return EDITABLE.filter((f) => !same(f, after[f], now[f])).map((f) => LABEL[f]);
}

/** Reverts the room's latest request that changed tasks: all its changes, or none. Refuses when a task changed since
 * (someone edited it in Vikunja) or became private. Kesha can't delete, so a task it created is closed instead. */
export async function undoLast(store: Store, vikunja: VikunjaApi, room: string): Promise<string> {
  const changes = store.lastChanges(room);
  if (!changes.length) return "Nothing to undo in this room.";

  // Check everything first, so an undo is never half done
  for (const c of changes) {
    const current = await vikunja.getTask(c.taskId);
    if (isPrivate(current)) return `I can't undo: task #${c.taskId} is private now.`;
    const changed = drift(c.after as TaskFields, editableFields(current));
    // A request may change one task twice; only the newest change has to match the task as it is now
    const newest = changes.find((x) => x.taskId === c.taskId) === c;
    if (newest && changed.length) return `I can't undo: task #${c.taskId} was changed since (${changed.join(", ")}). Fix it in Vikunja.`;
  }

  const done: string[] = [];
  for (const c of changes) {
    const title = String(c.after.title);
    if (c.kind === "create") {
      await vikunja.updateTask(c.taskId, { done: true });
      done.push(`- closed "${title}" (#${c.taskId}), which I had created. Closed, not deleted`);
    } else {
      await vikunja.updateTask(c.taskId, c.before as TaskFields);
      const fields = drift(c.before as TaskFields, c.after as TaskFields);
      done.push(`- restored "${String(c.before!.title)}" (#${c.taskId})${fields.length ? `: ${fields.join(", ")}` : ""}`);
    }
  }
  store.markUndone(changes.map((c) => c.id));
  return `Undone:\n${done.join("\n")}`;
}
