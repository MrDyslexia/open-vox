import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";
import {
  defaultNarrationPolicies, flattenNarrationPlan, validateNarrationPlan, validateNarrationPolicies,
  validateSourceRange, type NarrationBlock, type NarrationLanguage, type NarrationPlan,
  type NarrationPolicies, type NarrationSegment, type SourceRange,
} from "./narration-plan";

type Context = { depth: number; quoteDepth: number };

/** Scan only AST-recognized HTML, never Markdown text or protected inline code.
 * Pairing spans AST blocks; quoted attributes, comments and raw-text elements
 * cannot accidentally introduce a tag. No HTML is rendered or executed.
 */
function htmlOmissions(tree: Nodes, original: string): SourceRange[] {
  const nodes: Nodes[] = [];
  function collect(node: Nodes): void {
    if (node.type === "html") nodes.push(node);
    else if ("children" in node) for (const child of node.children) collect(child);
  }
  collect(tree);
  const spans: SourceRange[] = [];
  const tags: string[] = [];
  let openingStart = 0;
  for (const node of nodes) {
    const source = validateSourceRange({ start: node.position?.start.offset, end: node.position?.end.offset }, original);
    spans.push(source);
    const raw = original.slice(source.start, source.end);
    const tokens = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<![a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>|<\/?[a-z][\w:-]*(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?>/gi;
    for (const match of raw.matchAll(tokens)) {
      const token = match[0];
      const tagMatch = /^<(\/)?([a-z][\w:-]*)/i.exec(token);
      if (!tagMatch) continue;
      const tag = tagMatch[2].toLowerCase();
      const closing = !!tagMatch[1];
      const rawText = ["script", "style", "textarea", "title"].includes(tags.at(-1) ?? "");
      if (rawText && !(closing && tags.at(-1) === tag)) continue;
      if (closing) {
        if (tags.at(-1) !== tag) continue;
        tags.pop();
        if (!tags.length) spans.push({ start: openingStart, end: source.start + match.index + token.length });
      } else if (!/\/\s*>$/.test(token)
        && !["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(tag)) {
        if (!tags.length) openingStart = source.start + match.index;
        tags.push(tag);
      }
    }
  }
  if (tags.length) spans.push({ start: openingStart, end: original.length });
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceRange[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Independent interpretation API. Does not call or replace prepareSpeech or any sink. */
export function createNarrationPlan(
  original: string,
  defaultLanguage: NarrationLanguage = "es",
  suppliedPolicy: NarrationPolicies = defaultNarrationPolicies,
): NarrationPlan {
  if (typeof original !== "string" || !["es", "en"].includes(defaultLanguage)) throw new Error("Invalid narration input");
  const policy = validateNarrationPolicies(suppliedPolicy);
  const tree = fromMarkdown(original, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const plan: NarrationPlan = {
    schemaVersion: 1, policy, original, defaultLanguage, offsetUnit: "utf16",
    rangeConvention: "end-exclusive", languageStatus: "unresolved", blocks: [], omissions: [],
    narrationLength: 0, outcome: "complete", truncated: false,
  };
  const range = (node: Nodes): SourceRange => validateSourceRange({
    start: node.position?.start.offset, end: node.position?.end.offset,
  }, original);
  const omit = (source: SourceRange, reason: string) => { plan.omissions.push({ source, reason }); };
  const htmlSpans = htmlOmissions(tree, original);
  for (const source of htmlSpans) omit(source, "html");
  const hidden = (source: SourceRange) => htmlSpans.some(span => span.start <= source.start && span.end >= source.end);
  const unknown = (node: Nodes) => {
    if (policy.markdown.unknown === "fail") throw new Error(`Unsupported Markdown node: ${node.type}`);
    omit(range(node), `unsupported-node:${node.type}`);
  };
  const block = (type: NarrationBlock["type"], node: Nodes, context: Context): NarrationBlock => {
    const result: NarrationBlock = { type, source: range(node), boundary: "newline", ...context, segments: [] };
    plan.blocks.push(result);
    return result;
  };

  function inline(nodes: Nodes[], target: NarrationBlock): void {
    let pendingOmission: { source: SourceRange; reason: string } | undefined;
    const removed = (source: SourceRange, reason: string) => {
      pendingOmission = { source: { start: pendingOmission?.source.start ?? source.start, end: source.end }, reason };
    };
    const append = (text: string, source: SourceRange, kind: NarrationSegment["kind"], protectedUnit = false) => {
      if (!text) return;
      const previous = target.segments.at(-1);
      if (pendingOmission && previous && /[\p{L}\p{N}\p{M}_$]$/u.test(previous.text) && /^[\p{L}\p{N}\p{M}_$]/u.test(text)) {
        target.segments.push({ text: " ", source: pendingOmission.source, kind: "text", protected: false, reason: pendingOmission.reason });
      }
      pendingOmission = undefined;
      target.segments.push({ text, source, kind, protected: protectedUnit });
    };
    function visit(node: Nodes): void {
      const source = range(node);
      if (hidden(source)) {
        removed(source, "html");
        return;
      }
      if ("children" in node && ["emphasis", "strong", "delete"].includes(node.type)) {
        for (const child of node.children) visit(child);
        return;
      }
      switch (node.type) {
        case "text": {
          // Lexical segmentation is not a Markdown parser. Source-exact text may be
          // bounded at whitespace; decoded escapes/entities stay atomic to retain trace.
          if (original.slice(source.start, source.end) !== node.value) {
            append(node.value, source, "text");
          } else {
            for (const match of node.value.matchAll(/\s+|\S+/gu)) {
              const start = source.start + match.index;
              append(match[0], { start, end: start + match[0].length }, "text");
            }
          }
          break;
        }
        case "inlineCode": append(node.value, source, "inlineCode", true); break;
        case "break": append("\n", source, "break"); break;
        case "link": {
          const raw = original.slice(source.start, source.end);
          // The maintained parser recognizes URI/email/GFM autolinks as links.
          // Explicit Markdown links begin with '[' and retain their deliberate label.
          if (!raw.startsWith("[")) {
            omit(source, "raw-url");
            removed(source, "raw-url");
          } else {
            inlineLink(node.children);
            omit(source, "link-destination");
          }
          break;
        }
        case "linkReference": inlineLink(node.children); omit(source, "link-destination"); break;
        case "image":
        case "imageReference":
          if (policy.markdown.image === "alt" && node.alt) append(node.alt, source, "imageAlt");
          else removed(source, "image");
          omit(source, node.alt && policy.markdown.image === "alt" ? "image-destination" : "image");
          break;
        default: unknown(node); removed(source, `unsupported-node:${node.type}`);
      }
    }
    function inlineLink(children: Nodes[]): void { for (const child of children) visit(child); }
    for (const node of nodes) visit(node);
  }

  function visit(node: Nodes, context: Context, item?: { source: SourceRange; number?: number }): void {
    if (hidden(range(node))) return;
    switch (node.type) {
      case "root": for (const child of node.children) visit(child, context); break;
      case "blockquote": for (const child of node.children) visit(child, { ...context, quoteDepth: context.quoteDepth + 1 }); break;
      case "list": {
        let number = node.start ?? 1;
        for (const child of node.children) {
          visit(child, { ...context, depth: context.depth + 1 }, { source: range(child), number: node.ordered ? number++ : undefined });
        }
        break;
      }
      case "listItem": {
        let first = true;
        for (const child of node.children) {
          visit(child, context, first && child.type === "paragraph" ? item : undefined);
          first = false;
        }
        break;
      }
      case "paragraph":
      case "heading": {
        const target = block(item ? "listItem" : node.type, node, context);
        if (item) {
          target.source = item.source;
          if (item.number !== undefined) {
            const marker = /^\d+[.)]/.exec(original.slice(item.source.start));
            if (!marker) throw new Error("Missing ordered-list source marker");
            const markerSource = { start: item.source.start, end: item.source.start + marker[0].length };
            if (!hidden(markerSource)) target.segments.push({ text: `${item.number}. `, source: markerSource, protected: true, kind: "numbering" });
          }
        }
        inline(node.children, target);
        if (target.segments.length && target.segments.every(s => s.kind === "numbering")) target.segments = [];
        break;
      }
      case "code":
      case "table": {
        const target = block(node.type, node, context);
        omit(target.source, node.type);
        if (policy.markdown[node.type] === "announce") target.segments.push({
          text: policy.announcements[node.type][defaultLanguage], source: target.source,
          protected: true, kind: "announcement", reason: node.type,
        });
        break;
      }
      case "thematicBreak": block("separator", node, context); omit(range(node), "thematic-break"); break;
      case "html": break; // Precomputed source spans already trace these omissions.
      case "definition": omit(range(node), "definition"); break;
      default: unknown(node);
    }
  }
  visit(tree, { depth: 0, quoteDepth: 0 });
  boundPlan(plan);
  return validateNarrationPlan(plan);
}

function boundPlan(plan: NarrationPlan): void {
  const allBlocks = plan.blocks;
  plan.blocks = [];
  for (const sourceBlock of allBlocks) {
    const target = { ...sourceBlock, segments: [] as NarrationSegment[] };
    plan.blocks.push(target);
    for (const segment of sourceBlock.segments) {
      target.segments.push(segment);
      const length = flattenNarrationPlan(plan).length;
      if (length <= plan.policy.maxNarrationLength) continue;
      target.segments.pop();
      let omittedStart = segment.source.start;
      // Whitespace alone must not leave a trailing partial token in the spoken wire.
      while (target.segments.length && /^\s+$/u.test(target.segments.at(-1)!.text)) {
        omittedStart = target.segments.pop()!.source.start;
      }
      const tooLarge = segment.kind === "inlineCode" && segment.text.length > plan.policy.maxNarrationLength;
      plan.outcome = tooLarge ? "unsplittable" : "truncated";
      plan.truncated = true;
      // Numbering without any item text is not a useful partial narration.
      if (target.segments.length && target.segments.every(s => s.kind === "numbering")) {
        omittedStart = target.segments[0].source.start;
        target.segments = [];
      }
      plan.omissions.push({ source: { start: omittedStart, end: plan.original.length }, reason: tooLarge ? "protected-unit-too-large" : "length-limit" });
      plan.narrationLength = flattenNarrationPlan(plan).length;
      return;
    }
  }
  plan.narrationLength = flattenNarrationPlan(plan).length;
}
