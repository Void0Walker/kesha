import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Anonymizer, parseDictionary, UnknownPlaceholderError } from "../src/anonymizer.ts";
import { Store } from "../src/store.ts";

// Fictional people and places only
const DICT = `
people:
  - names: [Jana Nováková, Jana, Nováková]
    forms: [Jany, Janě, Janou, Novákové, Novákovou]
  - names: [Petr Svoboda, Petr]
    forms: [Petra, Petrovi]
places:
  - names: [Vinohradská 12, Vinohradská]
orgs:
  - names: [Acme s.r.o., Acme]
other:
  - names: [example.com]
`;

const setup = () => {
  const store = new Store(":memory:", "Europe/Berlin");
  return { store, a: new Anonymizer(parseDictionary(DICT), store) };
};

describe("anonymizer", () => {
  it("maps every form of a person to one placeholder and restores the first name", () => {
    const { a } = setup();
    const { text } = a.anonymize("t1", "Zavolat Janě, pak napsat Jany mámě. Jana Nováková má narozeniny.");
    assert.equal(text, "Zavolat <PERSON_1>, pak napsat <PERSON_1> mámě. <PERSON_1> má narozeniny.");
    assert.equal(a.deanonymize("t1", "Remind <PERSON_1>"), "Remind Jana Nováková");
  });

  it("numbers new entities in order and keeps them stable within a thread", () => {
    const { a } = setup();
    assert.equal(a.anonymize("t1", "Petr and Jana").text, "<PERSON_1> and <PERSON_2>");
    assert.equal(a.anonymize("t1", "Jana again, then Petrovi").text, "<PERSON_2> again, then <PERSON_1>");
  });

  it("numbers each thread independently", () => {
    const { a } = setup();
    a.anonymize("t1", "Petr");
    assert.equal(a.anonymize("t2", "Jana").text, "<PERSON_1>");
    assert.equal(a.deanonymize("t2", "<PERSON_1>"), "Jana Nováková");
    assert.equal(a.deanonymize("t1", "<PERSON_1>"), "Petr Svoboda");
  });

  it("matches whole words only, in any case", () => {
    const { a } = setup();
    assert.equal(a.anonymize("t1", "Petrol, Janapur, Acmeology").text, "Petrol, Janapur, Acmeology");
    assert.equal(a.anonymize("t1", "JANA and acme").text, "<PERSON_1> and <ORG_1>");
  });

  it("prefers the longest form", () => {
    const { a } = setup();
    assert.equal(a.anonymize("t1", "Deliver to Vinohradská 12 for Acme s.r.o.").text, "Deliver to <PLACE_1> for <ORG_1>");
  });

  it("replaces structured PII", () => {
    const { a } = setup();
    const cases: [string, string][] = [
      ["mail jana.n@mail.example.org now", "mail <EMAIL_1> now"],
      ["call +420 601 234 567", "call <PHONE_1>"],
      ["call 601 234 567", "call <PHONE_1>"],
      ["pay CZ65 0800 0000 1920 0014 5399", "pay <IBAN_1>"],
      ["card 4111 1111 1111 1111", "card <CARD_1>"],
      ["ssh to 192.168.1.20", "ssh to <IP_1>"],
      ["open https://files.example.net/share?token=abc123 later", "open <URL_1> later"],
    ];
    for (const [input, expected] of cases) assert.equal(a.anonymize(`t-${input}`, input).text, expected, input);
  });

  it("leaves ordinary numbers, dates and times alone", () => {
    const { a } = setup();
    const text = "Task 42 due 2026-10-10 at 10:30:00, priority 3, 1500 CZK, card-like 1234 5678 9012 3456";
    assert.equal(a.anonymize("t1", text).text, text);
  });

  it("does not rewrite inside existing placeholders", () => {
    const { a } = setup();
    a.anonymize("t1", "Jana");
    assert.equal(a.anonymize("t1", "<PERSON_1> and Petr").text, "<PERSON_1> and <PERSON_2>");
  });

  it("deep-anonymizes JSON values", () => {
    const { a } = setup();
    const out = a.anonymizeValue("t1", { tasks: [{ id: 1, title: "Gift for Jana", labels: ["family"] }] });
    assert.deepEqual(out, { tasks: [{ id: 1, title: "Gift for <PERSON_1>", labels: ["family"] }] });
  });

  it("rejects invented placeholders in tool arguments but keeps them in replies", () => {
    const { a } = setup();
    a.anonymize("t1", "Jana");
    assert.throws(() => a.deanonymizeValueStrict("t1", { title: "Call <PERSON_7>" }), UnknownPlaceholderError);
    assert.deepEqual(a.deanonymizeValueStrict("t1", { title: "Call <PERSON_1>" }), { title: "Call Jana Nováková" });
    assert.equal(a.deanonymize("t1", "<PERSON_7>?"), "<PERSON_7>?");
  });

  it("rejects unknown sections in the dictionary file", () => {
    assert.throws(() => parseDictionary("friends:\n  - names: [X]\n"));
  });
});

describe("search variants", () => {
  it("expands a canonical name to all its spellings and leaves other terms alone", () => {
    const { a } = setup();
    assert.deepEqual(a.variants("Jana Nováková").sort(), ["Jana", "Jana Nováková", "Janou", "Janě", "Jany", "Nováková", "Novákové", "Novákovou"].sort());
    assert.deepEqual(a.variants("Jana"), ["Jana"]);
    assert.deepEqual(a.variants("milk"), ["milk"]);
  });
});

describe("Czech birth numbers", () => {
  it("replaces them, with or without spaces around the slash, and restores them", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const a = new Anonymizer(parseDictionary(""), store);
    const out = a.anonymize("t", "RČ 855612/1234 a 040115 / 123").text;
    assert.equal(out, "RČ <ID_1> a <ID_2>");
    assert.equal(a.deanonymize("t", "Číslo: <ID_1>"), "Číslo: 855612/1234");
  });

  it("leaves dates, plain numbers and file numbers alone", () => {
    const store = new Store(":memory:", "Europe/Berlin");
    const a = new Anonymizer(parseDictionary(""), store);
    const text = "11.10.2026, č.j. 12/2026, 8556121234, 1234567/123456";
    assert.equal(a.anonymize("t", text).text, text);
  });
});
