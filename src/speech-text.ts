export type Language = "es" | "en";

const SPANISH_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "que", "y", "en", "es", "por", "con",
  "para", "como", "pero", "más", "este", "esta", "esto", "son", "está", "están", "se", "su", "sus", "al",
  "lo", "ya", "muy", "hay", "fue", "ser", "tiene", "puede", "hola", "también", "cuando", "donde", "porque",
  "aquí", "sí", "no", "nos", "les", "me", "te", "si", "o", "mi", "tu",
]);
const ENGLISH_WORDS = new Set([
  "the", "and", "is", "are", "was", "were", "of", "to", "in", "that", "it", "for", "with", "as", "this",
  "have", "has", "be", "not", "you", "your", "but", "on", "at", "by", "from", "an", "or", "can", "will",
  "here", "there", "what", "which", "when", "where", "because", "they", "we", "i", "my", "do", "does",
]);

/** Heuristic ES/EN detection. Ties and empty input fall back to English. */
export function detectLanguage(text: string): Language {
  const words = text.toLowerCase().match(/[a-záéíóúüñ]+/g) ?? [];
  let es = 0;
  let en = 0;
  for (const word of words) {
    if (SPANISH_WORDS.has(word)) es++;
    if (ENGLISH_WORDS.has(word)) en++;
  }
  if (/[¿¡ñáéíóú]/i.test(text)) es += 2;
  return es > en ? "es" : "en";
}

/** Converts Markdown into plain text suitable for speech. */
export function prepareSpeech(markdown: string, maxLength = 4000): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/```[\s\S]*?```/g, "\n");
  text = text.replace(/~~~[\s\S]*?~~~/g, "\n");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/<[^>\n]+>/g, "");
  text = text.replace(/`([^`\n]*)`/g, "$1");
  const lines = text.split("\n").flatMap((line) => {
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) return [];
    let out = line;
    if (/^\s*\|.*\|\s*$/.test(out)) out = out.trim().slice(1, -1).split("|").map((c) => c.trim()).join(" ");
    out = out.replace(/^\s{0,3}#{1,6}\s+/, "");
    out = out.replace(/^\s*>+\s?/, "");
    out = out.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
    out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
    out = out.replace(/(\*|_)([^*_\n]+)\1/g, "$2");
    out = out.replace(/[ \t]+/g, " ").trim();
    return out ? [out] : [];
  });
  const result = lines.join("\n");
  if (result.length <= maxLength) return result;
  const cut = result.slice(0, maxLength);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (boundary > 0) return cut.slice(0, boundary + 1).trim();
  return cut.trim();
}
