import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectLanguage, languageNote } from "../src/language.ts";

describe("detectLanguage", () => {
  it("tells the user's language from their words, not the country they ask about", () => {
    assert.equal(detectLanguage("[Tue 2026-10-13 13:40 +02:00] find me some good thermometer and humidity meter. Look in Czech stores."), "English");
    assert.equal(detectLanguage("najdi mi dobrý teploměr a vlhkoměr v českých obchodech"), "Czech");
    assert.equal(detectLanguage("finde mir bitte ein gutes Thermometer, und wo kann ich es kaufen?"), "German");
    assert.equal(detectLanguage("найди мне хороший термометр и где его купить"), "Russian");
    assert.equal(detectLanguage("знайди мені гарний термометр, де купити?"), "Ukrainian");
  });

  it("isn't fooled by Czech product names, placeholders or links in an English message", () => {
    assert.equal(detectLanguage("is the Airbi SMILE teploměr from <PERSON_1> any good? https://www.alza.cz/teplomer"), "English");
  });

  it("leaves short or mixed messages undecided", () => {
    assert.equal(detectLanguage("cheaper?"), undefined);
    assert.equal(detectLanguage("Xiaomi 2"), undefined);
  });
});

describe("languageNote", () => {
  it("names the language when known, else asks for the user's", () => {
    assert.match(languageNote("English"), /writes in English\. Reply in English/);
    assert.match(languageNote(undefined), /language of the user's words above/);
  });
});
