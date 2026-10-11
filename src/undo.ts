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

export interface UndoResult {
  message: string;
  // Something in Vikunja was changed back
  reverted: boolean;
}

/** Reverts the room's latest request that changed tasks. Everything is checked before the first write; refuses when a
 * task changed since (someone edited it in Vikunja) or became private. Each change is marked undone right after its
 * write, so if Vikunja fails midway, the next !undo continues with the rest. Kesha can't delete: a task it created is
 * closed instead. */
export async function undoLast(store: Store, vikunja: VikunjaApi, room: string): Promise<UndoResult> {
  const changes = store.lastChanges(room);
  if (!changes.length) return { message: "Nothing to undo in this room.", reverted: false };

  for (const c of changes) {
    const current = await vikunja.getTask(c.taskId);
    if (isPrivate(current)) return { message: `I can't undo: task #${c.taskId} is private now.`, reverted: false };
    const changed = drift(c.after as TaskFields, editableFields(current));
    // A request may change one task twice; only the newest change has to match the task as it is now
    const newest = changes.find((x) => x.taskId === c.taskId) === c;
    if (newest && changed.length) {
      return { message: `I can't undo: task #${c.taskId} was changed since (${changed.join(", ")}). Fix it in Vikunja.`, reverted: false };
    }
  }

  const done: string[] = [];
  let reverted = false;
  for (const c of changes) {
    const title = String(c.after.title);
    try {
      if (c.kind === "create" && c.after.done) {
        done.push(`- "${title}" (#${c.taskId}) was created already done, and I can't delete tasks: delete it in Vikunja if you don't want it`);
      } else if (c.kind === "create") {
        await vikunja.updateTask(c.taskId, { done: true });
        reverted = true;
        done.push(`- closed "${title}" (#${c.taskId}), which I had created. Closed, not deleted`);
      } else {
        await vikunja.updateTask(c.taskId, c.before as TaskFields);
        reverted = true;
        const fields = drift(c.before as TaskFields, c.after as TaskFields);
        done.push(`- restored "${String(c.before!.title)}" (#${c.taskId})${fields.length ? `: ${fields.join(", ")}` : ""}`);
      }
      store.markUndone([c.id]);
    } catch (e) {
      console.error("undo failed:", e);
      const soFar = done.length ? `Undone so far:\n${done.join("\n")}\n` : "";
      return { message: `${soFar}Vikunja failed while undoing #${c.taskId}. Send !undo again to continue with the rest.`, reverted };
    }
  }
  return { message: `Undone:\n${done.join("\n")}`, reverted };
}
