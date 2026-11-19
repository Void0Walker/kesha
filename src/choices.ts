import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Tool } from "./tools.ts";

// Products the user chose for a shopping item ("voda" → Magnesia 1.5 l), remembered across conversations. !shop gives
// them to the model with the list, so it adds them by id instead of searching and choosing again. Only the user's own
// choices are recorded (picked from options, named, or a correction), never the model's guesses.

export interface ProductChoice {
  // As the user writes it on the list, e.g. "voda"
  item: string;
  productId: string;
  product: string;
  // E.g. "6-pack", "the blue one"
  note?: string;
  updatedAt: number;
}

// The model gets all of them with every !shop. More than this is a sign of something odd, the oldest are left out
const MAX_CHOICES = 150;

const key = (item: string) => item.trim().replace(/\s+/g, " ").toLocaleLowerCase();

export class ProductChoices {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS product_choices (
      key TEXT PRIMARY KEY, item TEXT NOT NULL, product_id TEXT NOT NULL, product TEXT NOT NULL, note TEXT,
      updated_at INTEGER NOT NULL)`);
  }

  /** Newest first. */
  list(limit = MAX_CHOICES): ProductChoice[] {
    const rows = this.#db.prepare("SELECT item, product_id, product, note, updated_at FROM product_choices ORDER BY updated_at DESC, key LIMIT ?")
      .all(limit) as { item: string; product_id: string; product: string; note: string | null; updated_at: number }[];
    return rows.map((r) => ({ item: r.item, productId: r.product_id, product: r.product, ...(r.note ? { note: r.note } : {}), updatedAt: r.updated_at }));
  }

  /** A new choice for an item replaces the old one. */
  remember(c: { item: string; productId: string; product: string; note?: string }): void {
    this.#db.prepare(`INSERT INTO product_choices (key, item, product_id, product, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET item = excluded.item, product_id = excluded.product_id, product = excluded.product,
        note = excluded.note, updated_at = excluded.updated_at`)
      .run(key(c.item), c.item.trim(), c.productId, c.product, c.note ?? null, this.#now());
  }

  forget(item: string): boolean {
    return Number(this.#db.prepare("DELETE FROM product_choices WHERE key = ?").run(key(item)).changes) > 0;
  }
}

/** For the !shop message, after the list. */
export function choicesText(choices: ProductChoice[]): string {
  if (!choices.length) return "";
  const lines = choices.map((c) => `${c.item} → ${c.product} (product id ${c.productId}${c.note ? `; ${c.note}` : ""})`);
  return `(Context from Kesha, not from the user: products the user chose before, by item. Use them for matching items unless the user says otherwise: add them by product id without searching, and search only if adding fails or the product is gone: ${lines.join("; ")})`;
}

/** Tools the shopping model uses to record and drop the user's choices. */
const tool = <S extends z.ZodType>(t: Tool<S>): Tool => t as unknown as Tool;

export function choiceTools(choices: ProductChoices): Tool[] {
  return [tool({
    name: "remember_product_choice",
    description: "Remember which Rohlík product the user wants for an item, for future shopping. Only when the user picked it from options, named it, or corrected your choice; never for your own guess.",
    schema: z.object({
      item: z.string().min(1).max(100).describe("the item as the user writes it on the list, e.g. \"voda\" or \"mléko\""),
      product_id: z.union([z.string().min(1).max(50), z.number()]).describe("Rohlík's product id"),
      product: z.string().min(1).max(200).describe("product name with size, e.g. \"Magnesia Mg2+ 1,5 l\""),
      note: z.string().max(200).optional().describe("anything else the user said, e.g. \"buy a 6-pack\""),
    }).strict(),
    async run(a) {
      choices.remember({ item: a.item, productId: String(a.product_id), product: a.product, ...(a.note ? { note: a.note } : {}) });
      return { remembered: a.item };
    },
  }), tool({
    name: "forget_product_choice",
    description: "Forget the remembered product for an item, when the user no longer wants it.",
    schema: z.object({ item: z.string().min(1).max(100) }).strict(),
    async run(a) {
      return choices.forget(a.item) ? { forgotten: a.item } : { error: `nothing remembered for "${a.item}"` };
    },
  })];
}
