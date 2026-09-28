// Adapted behavior kernel from Caveman v2.7.0 (commit 8b0c1d3699b8d83e87fe4605b378da20c41555e0).
// Injected into system message to encourage concise chat replies without sacrificing clarity.

export const CAVEMAN_LEVELS = {
  LITE: "lite",
  FULL: "full",
  ULTRA: "ultra",
  WENYAN_LITE: "wenyan-lite",
  WENYAN: "wenyan",
  WENYAN_ULTRA: "wenyan-ultra",
};
const VALID_CAVEMAN_LEVELS = new Set(Object.values(CAVEMAN_LEVELS));

export function isValidCavemanLevel(level) {
  if (typeof level !== "string") return false;
  const normalized = level.trim().toLowerCase();
  return normalized === "wenyan-full" || VALID_CAVEMAN_LEVELS.has(normalized);
}

export function normalizeCavemanLevel(level, fallback = null) {
  if (typeof level !== "string") return fallback;
  const normalized = level.trim().toLowerCase();
  if (normalized === "wenyan-full") return CAVEMAN_LEVELS.WENYAN;
  if (VALID_CAVEMAN_LEVELS.has(normalized)) return normalized;
  return fallback;
}

const SHARED_RULES = [
  "Compress chat prose, not meaning. Clarity and requested detail win over brevity.",
  "Keep not/never/no/only/except, numbers, units and technical facts exact. Preserve uncertainty and conditions.",
  "Do not add words or break grammar to sound terse; prefer plain wording when compression saves nothing.",
  "One idea per sentence; short sentences, active voice, imperative instructions, consistent terms, clear pronoun references. Keep grammatical particles and postpositions.",
  "Code, identifiers, paths, commands, URLs and quoted errors stay exact.",
  "Use normal prose for security warnings, irreversible-action confirmations, ambiguous sequences, clarification or repeated questions; resume terse chat afterward.",
  "Persisted artifacts (code comments, commits, docs, issues, PRs, reports, memory files, third-party messages) use normal prose in the requested language, even when drafted in chat.",
  "Fulfill requested explanations and formats; do not omit substance.",
  "No invented abbreviations; standard technical acronyms are fine. No decorative emoji, filler, status phrases, unrequested tool narration or causal-arrow shorthand.",
  "Do not announce the style unless asked. Apply consistently while enabled; explicit user requests override this style.",
].join(" ");

const SHARED_PRESERVE_LANGUAGE =
  "Follow explicit reply-language instructions. Otherwise preserve the user's dominant language; only Wenyan levels default to classical Chinese. Examples never select the reply language. Technical literals stay in their original form.";

export const CAVEMAN_PROMPTS = {
  [CAVEMAN_LEVELS.LITE]: [
    "Respond tersely with full sentences and correct grammar; remove filler.",
    SHARED_RULES,
    SHARED_PRESERVE_LANGUAGE,
  ].join(" "),

  [CAVEMAN_LEVELS.FULL]: [
    "Respond tersely; omit articles only where safe, use fragments only when unambiguous.",
    SHARED_RULES,
    SHARED_PRESERVE_LANGUAGE,
  ].join(" "),

  [CAVEMAN_LEVELS.ULTRA]: [
    "Respond ultra-terse. Omit conjunctions only when cause, sequence and meaning stay unambiguous. State each fact once.",
    SHARED_RULES,
    SHARED_PRESERVE_LANGUAGE,
  ].join(" "),

  [CAVEMAN_LEVELS.WENYAN_LITE]: [
    "Default to semi-classical Chinese; preserve grammatical structure and technical terms.",
    SHARED_RULES,
    SHARED_PRESERVE_LANGUAGE,
  ].join(" "),

  [CAVEMAN_LEVELS.WENYAN]: [
    "Default to classical Chinese (文言文), concise classical phrasing with natural particles.",
    SHARED_RULES,
    SHARED_PRESERVE_LANGUAGE,
  ].join(" "),

  [CAVEMAN_LEVELS.WENYAN_ULTRA]: [
    "Default to very concise classical Chinese (文言文); preserve meaning, natural particles and technical terms.",
    SHARED_RULES,
    SHARED_PRESERVE_LANGUAGE,
  ].join(" "),
};
