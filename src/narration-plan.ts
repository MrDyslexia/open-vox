import { readFileSync } from "node:fs";

export type NarrationLanguage = "es" | "en";
export type SourceRange = { start: number; end: number };
export type NarrationSegment = {
  text: string;
  source: SourceRange;
  protected: boolean;
  kind: "text" | "inlineCode" | "imageAlt" | "announcement" | "numbering" | "break";
  reason?: string;
};
export type NarrationBlock = {
  type: "paragraph" | "heading" | "listItem" | "code" | "table" | "separator";
  source: SourceRange;
  boundary: "newline";
  depth: number;
  quoteDepth: number;
  segments: NarrationSegment[];
};
export type NarrationOmission = { source: SourceRange; reason: string };
export type NarrationPolicies = {
  schemaVersion: 1;
  maxNarrationLength: number;
  markdown: {
    code: "announce" | "omit";
    table: "announce" | "omit";
    image: "alt" | "omit";
    link: "visible-text";
    rawUrl: "omit";
    html: "omit-with-content";
    definition: "omit";
    thematicBreak: "separate";
    unknown: "omit" | "fail";
  };
  announcements: Record<"code" | "table", Record<NarrationLanguage, string>>;
  resolver: {
    acronyms: Record<string, Record<NarrationLanguage, string>>;
    names: Record<string, NarrationLanguage>;
    expressions: Record<string, NarrationLanguage>;
    fallback: "defaultLanguage";
  };
};
export type NarrationPlan = {
  schemaVersion: 1;
  policy: NarrationPolicies;
  original: string;
  offsetUnit: "utf16";
  rangeConvention: "end-exclusive";
  defaultLanguage: NarrationLanguage;
  languageStatus: "unresolved";
  blocks: NarrationBlock[];
  omissions: NarrationOmission[];
  narrationLength: number;
  outcome: "complete" | "truncated" | "unsplittable";
  truncated: boolean;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid narration wire: ${message}`);
}

function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  requireValue(required.every(key => Object.hasOwn(value, key)), "missing field");
  requireValue(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), "unknown field");
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max, "unsafe integer");
}

function choice(value: unknown, values: readonly unknown[]): void {
  requireValue(values.includes(value), "unsupported enum");
}

function text(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0, "expected nonempty text");
}

function bilingual(value: unknown): void {
  const pair = object(value);
  keys(pair, ["es", "en"]);
  text(pair.es);
  text(pair.en);
}

function reason(value: unknown): void {
  text(value);
  requireValue(["code", "table", "html", "definition", "raw-url", "image", "image-destination",
    "link-destination", "thematic-break", "length-limit", "protected-unit-too-large"].includes(value)
    || /^unsupported-node:[a-zA-Z][a-zA-Z0-9]*$/.test(value), "unsupported trace reason");
}

/** Returns a detached JSON policy; resolver dictionaries are evidence, not applied in I01. */
export function validateNarrationPolicies(value: unknown): NarrationPolicies {
  const policy = object(value);
  keys(policy, ["schemaVersion", "maxNarrationLength", "markdown", "announcements", "resolver"]);
  choice(policy.schemaVersion, [1]);
  integer(policy.maxNarrationLength, 1, 4000);
  const markdown = object(policy.markdown);
  const actions = {
    code: ["announce", "omit"], table: ["announce", "omit"], image: ["alt", "omit"],
    link: ["visible-text"], rawUrl: ["omit"], html: ["omit-with-content"],
    definition: ["omit"], thematicBreak: ["separate"], unknown: ["omit", "fail"],
  };
  keys(markdown, Object.keys(actions));
  for (const [key, values] of Object.entries(actions)) choice(markdown[key], values);
  const announcements = object(policy.announcements);
  keys(announcements, ["code", "table"]);
  bilingual(announcements.code);
  bilingual(announcements.table);
  const resolver = object(policy.resolver);
  keys(resolver, ["acronyms", "names", "expressions", "fallback"]);
  choice(resolver.fallback, ["defaultLanguage"]);
  for (const [key, pair] of Object.entries(object(resolver.acronyms))) {
    text(key);
    bilingual(pair);
  }
  for (const dictionary of [resolver.names, resolver.expressions]) {
    for (const [key, language] of Object.entries(object(dictionary))) {
      text(key);
      choice(language, ["es", "en"]);
    }
  }
  return structuredClone(value) as NarrationPolicies;
}

export const defaultNarrationPolicies = validateNarrationPolicies(
  JSON.parse(readFileSync(new URL("../resources/narration-policies.json", import.meta.url), "utf8")),
);

/** mdast offsets and JavaScript string lengths use UTF16 code units, end-exclusive. */
export function validateSourceRange(value: unknown, original: string): SourceRange {
  const range = object(value);
  keys(range, ["start", "end"]);
  integer(range.start, 0, original.length);
  integer(range.end, range.start, original.length);
  for (const offset of [range.start, range.end]) {
    const previous = original.charCodeAt(offset - 1);
    const current = original.charCodeAt(offset);
    requireValue(!(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff), "mid-surrogate offset");
  }
  return { start: range.start, end: range.end };
}

/** This exact representation, including structural separators, is the bounded spoken input. */
export function flattenNarrationPlan(plan: Pick<NarrationPlan, "blocks">): string {
  return plan.blocks.map(block => {
    const texts = block.segments.map(segment => segment.text);
    // Trim layout whitespace only; CommonMark has already normalized inline code.
    // Protected segment whitespace is part of its literal value and cap accounting.
    for (let i = 0; i < texts.length && !block.segments[i].protected; i++) {
      texts[i] = texts[i].trimStart();
      if (texts[i]) break;
    }
    for (let i = texts.length - 1; i >= 0 && !block.segments[i].protected; i--) {
      texts[i] = texts[i].trimEnd();
      if (texts[i]) break;
    }
    return texts.join("");
  }).filter(Boolean).join("\n");
}

export function validateNarrationPlan(value: unknown): NarrationPlan {
  const plan = object(value);
  keys(plan, ["schemaVersion", "policy", "original", "offsetUnit", "rangeConvention", "defaultLanguage",
    "languageStatus", "blocks", "omissions", "narrationLength", "outcome", "truncated"]);
  choice(plan.schemaVersion, [1]);
  const policy = validateNarrationPolicies(plan.policy);
  requireValue(typeof plan.original === "string", "original must be a string");
  const original = plan.original;
  choice(plan.offsetUnit, ["utf16"]);
  choice(plan.rangeConvention, ["end-exclusive"]);
  choice(plan.defaultLanguage, ["es", "en"]);
  choice(plan.languageStatus, ["unresolved"]);
  choice(plan.outcome, ["complete", "truncated", "unsplittable"]);
  requireValue(typeof plan.truncated === "boolean" && plan.truncated === (plan.outcome !== "complete"), "inconsistent limit outcome");
  integer(plan.narrationLength, 0, policy.maxNarrationLength);
  requireValue(Array.isArray(plan.blocks) && Array.isArray(plan.omissions), "expected arrays");
  let previousBlockStart = 0;
  for (const entry of plan.blocks) {
    const block = object(entry);
    keys(block, ["type", "source", "boundary", "depth", "quoteDepth", "segments"]);
    choice(block.type, ["paragraph", "heading", "listItem", "code", "table", "separator"]);
    choice(block.boundary, ["newline"]);
    integer(block.depth, 0);
    integer(block.quoteDepth, 0);
    const span = validateSourceRange(block.source, original);
    requireValue(span.end > span.start, "empty structural block");
    requireValue(span.start >= previousBlockStart, "unordered blocks");
    previousBlockStart = span.start;
    requireValue(Array.isArray(block.segments), "expected segments");
    let previousSegmentEnd = span.start;
    for (const entry of block.segments) {
      const segment = object(entry);
      keys(segment, ["text", "source", "protected", "kind"], ["reason"]);
      requireValue(typeof segment.text === "string" && segment.text.length > 0, "empty segment");
      requireValue(typeof segment.protected === "boolean", "invalid protection");
      choice(segment.kind, ["text", "inlineCode", "imageAlt", "announcement", "numbering", "break"]);
      if (segment.reason !== undefined) reason(segment.reason);
      const range = validateSourceRange(segment.source, original);
      requireValue(range.start >= previousSegmentEnd && range.end <= span.end && range.end > range.start, "segment containment/order");
      previousSegmentEnd = range.end;
      if (["inlineCode", "announcement", "numbering"].includes(segment.kind as string)) {
        requireValue(segment.protected === true, "indivisible segment is not protected");
      }
    }
  }
  let hasLimit = false;
  let hasUnsplittable = false;
  for (const entry of plan.omissions) {
    const omission = object(entry);
    keys(omission, ["source", "reason"]);
    const span = validateSourceRange(omission.source, original);
    requireValue(span.end > span.start, "empty omission");
    reason(omission.reason);
    hasLimit ||= omission.reason === "length-limit";
    hasUnsplittable ||= omission.reason === "protected-unit-too-large";
  }
  requireValue((plan.outcome === "complete" && !hasLimit && !hasUnsplittable)
    || (plan.outcome === "truncated" && hasLimit && !hasUnsplittable)
    || (plan.outcome === "unsplittable" && hasUnsplittable), "missing/inconsistent limit trace");
  requireValue(flattenNarrationPlan(value as NarrationPlan).length === plan.narrationLength, "incorrect spoken length");
  return structuredClone(value) as NarrationPlan;
}
