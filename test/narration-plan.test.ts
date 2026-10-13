import { expect, test } from "bun:test";
import { createNarrationPlan } from "../src/markdown-narration";
import { defaultNarrationPolicies, flattenNarrationPlan, validateNarrationPlan, validateNarrationPolicies, validateSourceRange } from "../src/narration-plan";

test("policy wire is versioned, bilingual, and reusable", () => {
  const policy = validateNarrationPolicies(defaultNarrationPolicies);
  expect(policy.schemaVersion).toBe(1);
  expect(policy.resolver.acronyms.API).toEqual({ es: "a pe i", en: "ay pee eye" });
  expect(policy.resolver.acronyms.HTTP).toEqual({ es: "hache te te pe", en: "aitch tee tee pee" });
  expect(policy.resolver.names.TypeScript).toBe("en");
  expect(policy.resolver.expressions["Open editor"]).toBe("en");
  expect(policy.resolver.fallback).toBe("defaultLanguage");
});

test("policies reject malformed versions, actions, counts, dictionaries, and announcements", () => {
  for (const patch of [
    { schemaVersion: 2 }, { maxNarrationLength: NaN }, { maxNarrationLength: Infinity },
    { maxNarrationLength: -1 }, { maxNarrationLength: 4001 }, { maxNarrationLength: 1.5 },
    { markdown: {} }, { resolver: {} }, { announcements: { code: { es: 1, en: "x" } } },
  ]) expect(() => validateNarrationPolicies({ ...defaultNarrationPolicies, ...patch })).toThrow();
  const bad = structuredClone(defaultNarrationPolicies);
  (bad.markdown as Record<string, unknown>).html = "speak";
  expect(() => validateNarrationPolicies(bad)).toThrow();
});

test("plan roundtrip retains original and unresolved language with UTF16 end-exclusive offsets", () => {
  const original = "😀 e\u0301 **same** and **same**";
  const plan = createNarrationPlan(original, "es");
  expect(plan.original).toBe(original);
  expect(plan.offsetUnit).toBe("utf16");
  expect(plan.rangeConvention).toBe("end-exclusive");
  expect(plan.languageStatus).toBe("unresolved");
  expect(validateNarrationPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  const repeated = plan.blocks.flatMap(b => b.segments).filter(s => s.text === "same");
  expect(repeated.map(s => original.slice(s.source.start, s.source.end))).toEqual(["same", "same"]);
  expect(repeated[0].source.start).not.toBe(repeated[1].source.start);
});

test("plan validation fails closed on scalar, enum, span, containment, and derived count mutations", () => {
  const original = "😀 text";
  for (const patch of [
    { schemaVersion: 2 }, { defaultLanguage: "fr" }, { offsetUnit: "codepoint" },
    { narrationLength: NaN }, { narrationLength: Infinity }, { outcome: "ok" },
    { languageStatus: "resolved" }, { truncated: true }, { narrationLength: 0 },
  ]) expect(() => validateNarrationPlan({ ...createNarrationPlan(original), ...patch })).toThrow();
  for (const source of [{ start: 1, end: 2 }, { start: -1, end: 3 }, { start: 0, end: 99 }, { start: 4, end: 2 }]) {
    const plan = createNarrationPlan(original);
    plan.blocks[0].segments[0].source = source;
    expect(() => validateNarrationPlan(plan)).toThrow();
  }
  const plan = createNarrationPlan(original);
  plan.blocks[0].source.end = 2;
  expect(() => validateNarrationPlan(plan)).toThrow();
});

test("cap includes separators, ordered numbers and announcements", () => {
  const plan = createNarrationPlan("1. alpha\n2. beta\n\n```\nx\n```", "en", { ...defaultNarrationPolicies, maxNarrationLength: 16 });
  expect(flattenNarrationPlan(plan)).toBe("1. alpha\n2. beta");
  expect(plan.narrationLength).toBe(16);
  expect(plan.outcome).toBe("truncated");
  expect(plan.omissions.some(o => o.reason === "length-limit")).toBe(true);
});

test("4000 exact, lexical truncation and protected oversized unit have explicit outcomes", () => {
  const exact = createNarrationPlan("x".repeat(4000));
  expect(exact.narrationLength).toBe(4000);
  expect(exact.outcome).toBe("complete");
  const over = createNarrationPlan("word ".repeat(900));
  expect(over.narrationLength).toBeLessThanOrEqual(4000);
  expect(flattenNarrationPlan(over).endsWith("word")).toBe(true);
  expect(over.truncated).toBe(true);
  const token = createNarrationPlan("`" + "x".repeat(4001) + "` after");
  expect(token.outcome).toBe("unsplittable");
  expect(token.narrationLength).toBe(0);
  expect(token.omissions.some(o => o.reason === "protected-unit-too-large")).toBe(true);
});

test("boundary never splits emoji, combining sequences, or technical tokens", () => {
  const policy = { ...defaultNarrationPolicies, maxNarrationLength: 5 };
  for (const token of ["😀😀😀", "e\u0301e\u0301e\u0301", "v1.2.3", "--verbose", "C:\\dir\\file", "/usr/local/bin"]) {
    const plan = createNarrationPlan("`" + token + "`", "en", policy);
    expect(plan.outcome).toBe("unsplittable");
    expect(flattenNarrationPlan(plan)).toBe("");
  }
});

test("source range validation rejects unsafe numbers and mid-surrogate endpoints", () => {
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => validateSourceRange({ start: value, end: 3 }, "😀x")).toThrow();
    expect(() => validateSourceRange({ start: 0, end: value }, "😀x")).toThrow();
  }
  expect(() => validateSourceRange({ start: 0, end: 1 }, "😀x")).toThrow();
  expect(validateSourceRange({ start: 0, end: 2 }, "😀x")).toEqual({ start: 0, end: 2 });
});

test("strict nested wire validation rejects types, missing fields, and dishonest traces", () => {
  const mutate = (change: (plan: ReturnType<typeof createNarrationPlan>) => void) => {
    const plan = createNarrationPlan("`API` and text");
    change(plan);
    expect(() => validateNarrationPlan(plan)).toThrow();
  };
  mutate(plan => { plan.blocks[0].depth = Infinity; });
  mutate(plan => { plan.blocks[0].boundary = "space" as never; });
  mutate(plan => { plan.blocks[0].segments[0].kind = "translated" as never; });
  mutate(plan => { plan.blocks[0].segments[0].protected = false; });
  mutate(plan => { plan.blocks[0].segments[0].text = ""; });
  mutate(plan => { plan.blocks[0].segments.reverse(); });
  mutate(plan => { plan.omissions.push({ source: { start: 0, end: 0 }, reason: "html" }); });
  mutate(plan => { plan.omissions.push({ source: { start: 0, end: 1 }, reason: "length-limit" }); });
  mutate(plan => { (plan as unknown as Record<string, unknown>).phonemes = "unverified"; });
  mutate(plan => { plan.blocks[0].source = { start: 0, end: 0 }; plan.blocks[0].segments = []; plan.narrationLength = 0; });
  mutate(plan => { plan.omissions.push({ source: { start: 0, end: 1 }, reason: "invented" }); });
  mutate(plan => { plan.blocks[0].segments[0].reason = "invented"; });
});

test("configuration snapshots do not alias caller policy or serialized plan", () => {
  const policy = structuredClone(defaultNarrationPolicies);
  const plan = createNarrationPlan("```\nx\n```", "en", policy);
  policy.announcements.code.en = "changed";
  expect(plan.policy.announcements.code.en).toBe("Code block omitted");
  const copy = validateNarrationPlan(plan);
  copy.blocks[0].segments[0].text = "changed";
  expect(flattenNarrationPlan(plan)).toBe("Code block omitted");
});

test("remaining-space exhaustion keeps an intact protected unit omitted and stops narration", () => {
  const plan = createNarrationPlan("first `API` after", "en", { ...defaultNarrationPolicies, maxNarrationLength: 7 });
  expect(flattenNarrationPlan(plan)).toBe("first");
  expect(plan.outcome).toBe("truncated");
  expect(plan.original.slice(plan.omissions.at(-1)!.source.start)).toBe(" `API` after");
  const numbered = createNarrationPlan("1. longword", "en", { ...defaultNarrationPolicies, maxNarrationLength: 3 });
  expect(flattenNarrationPlan(numbered)).toBe("");
  expect(numbered.outcome).toBe("truncated");
  expect(numbered.omissions.at(-1)!.source.start).toBe(0);
});

test("omission separators are source-traced and counted at the cap", () => {
  const original = "left<!-- hidden -->right";
  const exact = createNarrationPlan(original, "en", { ...defaultNarrationPolicies, maxNarrationLength: 10 });
  expect(flattenNarrationPlan(exact)).toBe("left right");
  expect(exact.narrationLength).toBe(10);
  expect(validateNarrationPlan(JSON.parse(JSON.stringify(exact)))).toEqual(exact);
  const over = createNarrationPlan(original, "en", { ...defaultNarrationPolicies, maxNarrationLength: 9 });
  expect(flattenNarrationPlan(over)).toBe("left");
  expect(over.outcome).toBe("truncated");
  expect(over.narrationLength).toBe(4);
});

test("flattening retains protected whitespace after CommonMark inline-code normalization", () => {
  const plan = createNarrationPlan("`  --flag  `", "en");
  expect(plan.blocks[0].segments[0].text).toBe(" --flag ");
  expect(flattenNarrationPlan(plan)).toBe(" --flag ");
  expect(plan.narrationLength).toBe(8);
});
