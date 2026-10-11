import { parse } from "yaml";
import { z } from "zod";

// Reversible pseudonymization at the OpenRouter boundary. Known entities come from the sops-encrypted dictionary,
// structured PII (emails, phone numbers, ...) from regexes. Placeholders are numbered per conversation, so the
// same person is <PERSON_1> throughout one conversation but can't be linked across conversations.

export type Kind = "PERSON" | "PLACE" | "ORG" | "OTHER" | "EMAIL" | "PHONE" | "IBAN" | "CARD" | "IP" | "URL";

export interface DictionaryEntry {
  kind: Kind;
  // Restored when the placeholder comes back. The first name listed in the file
  canonical: string;
  // Every spelling that maps to this entry: all names plus the inflected forms
  forms: string[];
}

export interface MappingStore {
  findPlaceholder(thread: string, value: string): string | undefined;
  lookupPlaceholder(thread: string, placeholder: string): string | undefined;
  countKind(thread: string, kind: string): number;
  addMapping(thread: string, placeholder: string, kind: string, value: string): void;
}

const Section = z.array(z.object({ names: z.array(z.string().min(1)).min(1), forms: z.array(z.string().min(1)).optional() }));
const DictionaryFile = z
  .object({ people: Section.optional(), places: Section.optional(), orgs: Section.optional(), other: Section.optional() })
  .strict();

export function parseDictionary(yamlText: string): DictionaryEntry[] {
  const file = DictionaryFile.parse(parse(yamlText) ?? {});
  const sections: [keyof typeof file, Kind][] = [["people", "PERSON"], ["places", "PLACE"], ["orgs", "ORG"], ["other", "OTHER"]];
  return sections.flatMap(([key, kind]) =>
    (file[key] ?? []).map((e) => ({ kind, canonical: e.names[0]!, forms: [...e.names, ...(e.forms ?? [])] })),
  );
}

const PLACEHOLDER = /<([A-Z]+)_(\d+)>/g;
// Letters and digits in any script count as word characters, so "Jan" doesn't match inside "January" or "Janě"
const W = "[\\p{L}\\p{N}_]";
const fold = (s: string) => s.normalize("NFC").toLocaleLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

interface Pattern {
  kind: Kind;
  re: RegExp;
  accept?: (match: string) => boolean;
}

// Order matters: whole URLs and emails first, so the dictionary or the phone pattern doesn't cut them apart.
const PATTERNS: Pattern[] = [
  { kind: "URL", re: /https?:\/\/[^\s<>"']*[?&#](?:token|access_token|key|api_key|apikey|sig|signature|secret|auth|password|pass|code|session|sid)=[^\s<>"']*/gi },
  { kind: "EMAIL", re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu },
  { kind: "IBAN", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { kind: "CARD", re: /\b\d(?:[ -]?\d){12,18}\b/g, accept: (m) => luhn(m.replace(/\D/g, "")) },
  // IPv4, full IPv6, compressed IPv6
  { kind: "IP", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\b/gi },
  // International numbers, and 9-digit national numbers in groups of three (CZ/SK style)
  { kind: "PHONE", re: /(?<![\w+])(?:(?:\+|00)\d{1,3}(?:[ -]?\d{2,4}){2,5}|\d{3} \d{3} \d{3})(?!\w)/g },
];
// One regex per kind, so placeholders are numbered in the order things appear in the text

// Labels OpenRouter's "Sensitive Info" guardrail puts in place of what it redacts. One-way: nothing can restore them
const PROVIDER_REDACTION = /\[(?:EMAIL|PHONE|SSN|CREDIT_CARD|IP_ADDRESS|PERSON_NAME|ADDRESS|REDACTED|SECRET:[\w.-]+)\]/g;

export class ProviderRedactionError extends Error {
  constructor(labels: string[]) {
    super(`${labels.join(", ")} was removed by the provider before you saw it and can't be recovered. Don't write it into tasks or search for it: leave that text out or unchanged, and tell the user what you couldn't see.`);
    this.name = "ProviderRedactionError";
  }
}

/** Throws when tool arguments carry the provider's redaction labels, so they never end up in Vikunja. */
export function rejectProviderRedactions(value: unknown): void {
  const labels = new Set<string>();
  mapStrings(value, (s) => {
    for (const m of s.matchAll(PROVIDER_REDACTION)) labels.add(m[0]);
    return s;
  });
  if (labels.size) throw new ProviderRedactionError([...labels]);
}

export class UnknownPlaceholderError extends Error {
  constructor(placeholders: string[]) {
    super(`unknown placeholder(s) ${placeholders.join(", ")}: only use placeholders that appeared in this conversation`);
    this.name = "UnknownPlaceholderError";
  }
}

export class Anonymizer {
  readonly #store: MappingStore;
  // All dictionary forms in one alternation (longest first, so "Jana Nováková" wins over "Jana"), matched in text order
  readonly #dictionaryRe: RegExp | undefined;
  readonly #byForm = new Map<string, DictionaryEntry>();

  constructor(entries: DictionaryEntry[], store: MappingStore) {
    this.#store = store;
    for (const entry of entries) for (const form of entry.forms) this.#byForm.set(fold(form), entry);
    const forms = [...this.#byForm.keys()].sort((a, b) => b.length - a.length);
    this.#dictionaryRe = forms.length ? new RegExp(`(?<!${W})(?:${forms.map(escape).join("|")})(?!${W})`, "giu") : undefined;
  }

  #placeholderFor(thread: string, kind: Kind, value: string): string {
    const key = `${kind}:${value}`;
    const existing = this.#store.findPlaceholder(thread, key);
    if (existing) return existing;
    const placeholder = `<${kind}_${this.#store.countKind(thread, kind) + 1}>`;
    this.#store.addMapping(thread, placeholder, kind, key);
    return placeholder;
  }

  /** Replace PII with placeholders. Text already containing placeholders is left alone around them. */
  anonymize(thread: string, text: string): { text: string; replaced: number } {
    let replaced = 0;
    const apply = (input: string, re: RegExp, toPlaceholder: (match: string) => string | undefined) =>
      // Split on existing placeholders (kept by the capture group) and only rewrite the parts in between
      input
        .split(/(<[A-Z]+_\d+>)/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(re, (m) => {
                const p = toPlaceholder(m);
                if (p) replaced++;
                return p ?? m;
              }),
        )
        .join("");

    let out = text.normalize("NFC");
    for (const p of PATTERNS) {
      out = apply(out, p.re, (m) => (!p.accept || p.accept(m) ? this.#placeholderFor(thread, p.kind, m) : undefined));
    }
    if (this.#dictionaryRe) {
      out = apply(out, this.#dictionaryRe, (m) => {
        const entry = this.#byForm.get(fold(m));
        return entry && this.#placeholderFor(thread, entry.kind, entry.canonical);
      });
    }
    return { text: out, replaced };
  }

  #restore(thread: string, text: string, strict: boolean): string {
    const unknown: string[] = [];
    const out = text.replace(PLACEHOLDER, (m) => {
      const key = this.#store.lookupPlaceholder(thread, m);
      if (key === undefined) {
        unknown.push(m);
        return m;
      }
      return key.slice(key.indexOf(":") + 1);
    });
    if (strict && unknown.length) throw new UnknownPlaceholderError(unknown);
    return out;
  }

  /** All spellings of a dictionary entry, given its canonical name. Anything else comes back as is. */
  variants(value: string): string[] {
    const entry = this.#byForm.get(fold(value));
    return entry && fold(entry.canonical) === fold(value) ? [...new Set(entry.forms)] : [value];
  }

  /** For the final reply: unknown placeholders stay as they are. */
  deanonymize(thread: string, text: string): string {
    return this.#restore(thread, text, false);
  }

  /** For tool arguments: an invented placeholder must not end up in Vikunja, so it's an error the model can fix. */
  deanonymizeStrict(thread: string, text: string): string {
    return this.#restore(thread, text, true);
  }

  /** Deep variants for JSON values (tool arguments and tool results). */
  anonymizeValue<T>(thread: string, value: T): T {
    return mapStrings(value, (s) => this.anonymize(thread, s).text);
  }

  deanonymizeValueStrict<T>(thread: string, value: T): T {
    return mapStrings(value, (s) => this.deanonymizeStrict(thread, s));
  }
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}
