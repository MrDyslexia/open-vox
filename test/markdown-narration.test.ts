import { expect, test } from "bun:test";
import { createNarrationPlan } from "../src/markdown-narration";
import { defaultNarrationPolicies, flattenNarrationPlan } from "../src/narration-plan";
import { prepareSpeech } from "../src/speech-text";

test("headings, nested lists, task items, quotes and paragraphs keep boundaries", () => {
  const plan = createNarrationPlan("# Title\n\nFirst **bold** and *soft* ~~gone~~.\n\n3. one\n   - child\n4. two\n\n- [x] task\n\n> quote\n>\n> next\n\n---\n\nLast", "en");
  expect(flattenNarrationPlan(plan)).toBe("Title\nFirst bold and soft gone.\n3. one\nchild\n4. two\ntask\nquote\nnext\nLast");
  expect(plan.blocks.map(b => b.type)).toEqual(["heading", "paragraph", "listItem", "listItem", "listItem", "listItem", "paragraph", "paragraph", "separator", "paragraph"]);
  expect(plan.blocks.find(b => b.depth === 2)?.type).toBe("listItem");
  expect(plan.blocks.filter(b => b.quoteDepth === 1)).toHaveLength(2);
});

for (const language of ["es", "en"] as const) test(`code and tables announce in ${language} without exposing contents`, () => {
  const plan = createNarrationPlan("before\n\n```ts\nsecret\n```\n\n    hidden\n\n| a | b |\n|---|---|\n| private | data |\n\nafter", language);
  const code = language === "es" ? "Bloque de código omitido" : "Code block omitted";
  const table = language === "es" ? "Tabla omitida" : "Table omitted";
  expect(flattenNarrationPlan(plan)).toBe(`before\n${code}\n${code}\n${table}\nafter`);
  expect(plan.omissions.filter(o => o.reason === "code")).toHaveLength(2);
  expect(plan.omissions.some(o => o.reason === "table")).toBe(true);
});

test("links, references, images and autolinks are traceable without URL speech", () => {
  const original = "[docs](https://example.com) [ref][id] ![diagram](x.png) ![](x.png) ![reference][pic]\n\n[id]: https://private.example\n[pic]: image.png\n\nleft<https://example.org>right and https://raw.example/path now";
  const plan = createNarrationPlan(original);
  expect(flattenNarrationPlan(plan)).toBe("docs ref diagram  reference\nleft right and  now");
  expect(plan.omissions.filter(o => o.reason === "definition")).toHaveLength(2);
  expect(plan.omissions.some(o => o.reason === "link-destination")).toBe(true);
  expect(plan.omissions.filter(o => o.reason === "raw-url")).toHaveLength(2);
  for (const omission of plan.omissions) expect(original.slice(omission.source.start, omission.source.end).length).toBeGreaterThan(0);
});

test("HTML blocks, comments and paired inline HTML omit hidden content conservatively", () => {
  const plan = createNarrationPlan("before <b>hidden **secret**</b> after <!-- private --> end\n\n<div>invisible</div>\n\n<script>alert(1)</script>\n\nvisible");
  expect(flattenNarrationPlan(plan)).toBe("before  after  end\nvisible");
  expect(plan.omissions.some(o => o.reason === "html")).toBe(true);
  expect(flattenNarrationPlan(createNarrationPlan("start <b>unclosed private"))).toBe("start");
});

test("inline code remains literal and protected before any later resolver", () => {
  const literals = ["getUserName", "API", "HTTP", ">=", "v1.2.3", "C:\\Users\\file", "/usr/bin/tool", "bun --flag", "1,234.56"];
  const plan = createNarrationPlan(literals.map(t => "`" + t + "`").join(" "));
  expect(plan.blocks.flatMap(b => b.segments).filter(s => s.protected).map(s => s.text)).toEqual(literals);
  expect(flattenNarrationPlan(plan)).toBe(literals.join(" "));
});

test("policy actions govern announcements and optional alt text rather than acting as metadata", () => {
  const policy = structuredClone(defaultNarrationPolicies);
  policy.markdown.code = "omit";
  policy.markdown.image = "omit";
  expect(flattenNarrationPlan(createNarrationPlan("![alt](x)\n\n```\nx\n```", "es", policy))).toBe("");
  policy.announcements.table.en = "Table skipped";
  expect(flattenNarrationPlan(createNarrationPlan("|a|\n|-|\n|b|", "en", policy))).toBe("Table skipped");
});

test("empty and omitted documents complete; unsupported GFM footnotes explicitly omitted", () => {
  expect(createNarrationPlan("").outcome).toBe("complete");
  expect(flattenNarrationPlan(createNarrationPlan("<!-- private -->"))).toBe("");
  const plan = createNarrationPlan("text[^a]\n\n[^a]: hidden");
  expect(plan.omissions.some(o => o.reason === "unsupported-node:footnoteReference")).toBe(true);
  expect(plan.omissions.some(o => o.reason === "unsupported-node:footnoteDefinition")).toBe(true);
});

test("legacy prepareSpeech remains independent and unchanged", () => {
  expect(prepareSpeech("```\nx\n```\n\n![alt](x)\n\n1. one")).toBe("one");
  expect(prepareSpeech("x".repeat(4001))).toHaveLength(4000);
  expect(flattenNarrationPlan(createNarrationPlan("1. one"))).toBe("1. one");
});

test("CommonMark escapes, entities, CRLF and hard breaks retain source-addressed evidence", () => {
  const original = "# 😀 title\r\n\r\nA &amp; B \\*literal\\*  \r\nnext e\u0301";
  const plan = createNarrationPlan(original, "en");
  expect(flattenNarrationPlan(plan)).toBe("😀 title\nA & B *literal*\nnext e\u0301");
  const decoded = plan.blocks[1].segments.find(s => s.text.includes("& B"))!;
  expect(original.slice(decoded.source.start, decoded.source.end)).toContain("&amp;");
  expect(plan.original).toBe(original);
});

test("ordered nesting, loose item paragraphs and image reference forms use the maintained AST", () => {
  const original = "7. outer\n\n   2. nested\n   3. again\n\n   continued\n\n8. end\n\n![pic][] ![pic]\n\n[pic]: https://image.example";
  const plan = createNarrationPlan(original, "en");
  expect(flattenNarrationPlan(plan)).toBe("7. outer\n2. nested\n3. again\ncontinued\n8. end\npic pic");
  expect(plan.blocks.filter(b => b.depth === 2)).toHaveLength(2);
  expect(plan.omissions.filter(o => o.reason === "image-destination")).toHaveLength(2);
});

test("HTML pairing is conservative for nesting, void tags and mismatched closing tags", () => {
  expect(flattenNarrationPlan(createNarrationPlan("a <b>x <i>y</i> z</b> c"))).toBe("a  c");
  expect(flattenNarrationPlan(createNarrationPlan("a <br> b <img src=x> c"))).toBe("a  b  c");
  expect(flattenNarrationPlan(createNarrationPlan("a <b>x</i> hidden"))).toBe("a");
  expect(flattenNarrationPlan(createNarrationPlan("a <span>hidden\n\nprivate</span> after\n\nlast"))).toBe("a\nafter\nlast");
});

test("link label emphasis is spoken; explicit URL labels and technical code stay literal", () => {
  const plan = createNarrationPlan("[**bold**](https://example.org) [https://label.example](https://destination.example) `https://technical.example`", "en");
  expect(flattenNarrationPlan(plan)).toBe("bold https://label.example https://technical.example");
});

test("unknown-node failure policy prevents silent unsupported feature loss", () => {
  const policy = structuredClone(defaultNarrationPolicies);
  policy.markdown.unknown = "fail";
  expect(() => createNarrationPlan("text[^a]\n\n[^a]: hidden", "en", policy)).toThrow("Unsupported Markdown node");
});

test("block HTML suppression survives AST block boundaries and nested outer elements", () => {
  for (const original of [
    "<div>\n\nhidden secret\n\n</div>\n\nvisible",
    "<div>\n\n<div>\n\ninner secret\n\n</div>\n\nouter secret\n\n</div>\n\nvisible",
    '<div data-note="quoted > value">\n\nhidden secret\n\n</div>\n\nvisible',
  ]) {
    const plan = createNarrationPlan(original, "en");
    expect(flattenNarrationPlan(plan)).toBe("visible");
    expect(plan.original).toBe(original);
    expect(plan.omissions.some(o => o.reason === "html"
      && original.slice(o.source.start, o.source.end) === original.slice(0, original.lastIndexOf("</div>") + 6))).toBe(true);
  }
});

test("paired inline HTML closes across paragraphs and retains visible postfix", () => {
  const original = "before <span>hidden\n\nsecret</span> after\n\nvisible";
  const plan = createNarrationPlan(original, "en");
  expect(flattenNarrationPlan(plan)).toBe("before\nafter\nvisible");
  expect(plan.omissions.filter(o => o.reason === "html").map(o => original.slice(o.source.start, o.source.end)))
    .toEqual(["<span>hidden\n\nsecret</span>"]);
  expect(flattenNarrationPlan(createNarrationPlan('<div data-x="a > b"><span>hidden</span></div>\n\nvisible', "en"))).toBe("visible");
});

test("unclosed HTML conservatively omits remainder; comments and self-closing tags do not open suppression", () => {
  expect(flattenNarrationPlan(createNarrationPlan("before <span>hidden\n\nprivate\n\nlast", "en"))).toBe("before");
  expect(flattenNarrationPlan(createNarrationPlan("<div>\n\nprivate\n\nlast", "en"))).toBe("");
  expect(flattenNarrationPlan(createNarrationPlan('left<x data-note="/> >"/>right', "en"))).toBe("left right");
  expect(flattenNarrationPlan(createNarrationPlan("left<!-- <div> fake </div> -->right", "en"))).toBe("left right");
  expect(flattenNarrationPlan(createNarrationPlan("<?processing <div>?>\n\nvisible", "en"))).toBe("visible");
  expect(flattenNarrationPlan(createNarrationPlan("<![CDATA[<div> hidden]]>\n\nvisible", "en"))).toBe("visible");
});

test("omissions separate adjacent words consistently without gratuitous punctuation or spaces", () => {
  for (const original of ["left<b>hidden</b>right", "left<!-- hidden -->right", "left![](image.png)right", "left[^id]right\n\n[^id]: hidden"]) {
    const plan = createNarrationPlan(original, "en");
    expect(flattenNarrationPlan(plan)).toBe("left right");
    expect(plan.original).toBe(original);
    const separator = plan.blocks.flatMap(b => b.segments).find(s => s.text === " " && s.reason);
    expect(separator).toBeDefined();
    expect(original.slice(separator!.source.start, separator!.source.end).length).toBeGreaterThan(0);
  }
  expect(flattenNarrationPlan(createNarrationPlan("left <!-- hidden --> right", "en"))).toBe("left  right");
  expect(flattenNarrationPlan(createNarrationPlan("left<!-- hidden -->, right", "en"))).toBe("left, right");
  expect(flattenNarrationPlan(createNarrationPlan("left![](x)!", "en"))).toBe("left!");
  expect(flattenNarrationPlan(createNarrationPlan("left![alt](x)right", "en"))).toBe("leftaltright");
});

test("recognized URI and GFM autolinks are omitted without losing deliberate labels or technical paths", () => {
  for (const url of ["ftp://example.org/file", "https://example.org", "urn:example:test", "mailto:user@example.org", "tel:+12345"]) {
    const original = `left<${url}>right`;
    const plan = createNarrationPlan(original, "en");
    expect(flattenNarrationPlan(plan)).toBe("left right");
    expect(plan.omissions.some(o => o.reason === "raw-url" && original.slice(o.source.start, o.source.end) === `<${url}>`)).toBe(true);
  }
  expect(flattenNarrationPlan(createNarrationPlan("left www.example.org right", "en"))).toBe("left  right");
  expect(flattenNarrationPlan(createNarrationPlan("[ftp://example.org/file](target) [**label**](ftp://example.org) `C:\\path\\file` `/usr/bin/tool`", "en")))
    .toBe("ftp://example.org/file label C:\\path\\file /usr/bin/tool");
});
