// Which language the user wrote in, for research replies: models told "the user's language" still answered in the
// language of the shops they were asked to search (2026-10-13), named outright they don't. Only languages the user
// is likely to write in; anything unclear is left undefined.

const WORDS: Record<string, string[]> = {
  English: ["the", "and", "is", "are", "to", "of", "in", "for", "me", "my", "i", "you", "what", "how", "find", "some", "with", "it",
    "this", "that", "can", "please", "which", "best", "good", "buy", "look", "where", "do", "does", "should", "or", "on", "at", "any",
    "need", "want", "cheaper", "more", "about", "there", "them", "one", "also"],
  Czech: ["a", "je", "jsou", "v", "ve", "na", "se", "si", "mi", "mě", "co", "jak", "jaký", "jaké", "který", "pro", "do", "z", "ze", "k",
    "o", "s", "že", "to", "najdi", "nějaký", "nějaké", "dobrý", "dobré", "chci", "potřebuju", "kde", "koupit", "prosím", "nebo", "ale",
    "jsem", "máš", "mám", "levnější", "taky", "také", "ještě"],
  German: ["der", "die", "das", "und", "ist", "nicht", "ich", "mir", "mich", "ein", "eine", "für", "mit", "auf", "im", "zu", "wie", "was",
    "bitte", "finde", "gute", "kaufen", "oder", "wo", "sind", "auch", "noch"],
  Russian: ["и", "в", "не", "на", "что", "я", "мне", "как", "это", "найди", "хороший", "хорошие", "где", "купить", "или", "для", "с", "по",
    "есть", "какой", "какие", "пожалуйста", "можно", "ещё", "еще", "дешевле"],
  Ukrainian: ["і", "й", "що", "як", "це", "мені", "знайди", "де", "купити", "або", "для", "з", "на", "є", "який", "які", "будь", "ще"],
};
// Letters that only one of these languages uses: one point for having any
const LETTERS: Record<string, RegExp> = { Czech: /[ěřů]/i, German: /[äöüß]/i, Russian: /[ыэъё]/i, Ukrainian: /[іїєґ]/i };

/** The language of the user's own words, or undefined when a message is too short or mixed to tell. */
export function detectLanguage(text: string): string | undefined {
  const words = text
    .replace(/^\[[^\]]*\]/, "")
    .replace(/<[A-Z_]+_\d+>|https?:\/\/\S+|`[^`]*`/g, " ")
    .toLowerCase()
    .match(/\p{L}+/gu) ?? [];
  const scores = Object.entries(WORDS).map(([lang, list]) => {
    const set = new Set(list);
    return [lang, words.filter((w) => set.has(w)).length + (LETTERS[lang]?.test(text) ? 1 : 0)] as const;
  }).sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = scores as [readonly [string, number], readonly [string, number]];
  return top >= 2 && top >= 2 * second ? best : undefined;
}

/** Said right after the user's words in research: names the language when it's known. */
export function languageNote(language: string | undefined): string {
  return language
    ? `(Context from Kesha, not from the user: the user writes in ${language}. Reply in ${language}, even when the pages and shops are in another language, unless the user asks for another one.)`
    : "(Context from Kesha, not from the user: answer in the language of the user's words above, even when the pages and shops are in another language.)";
}
