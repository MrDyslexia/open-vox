import { describe, expect, test } from "bun:test";
import { detectLanguage, prepareSpeech } from "../src/speech-text";

describe("detectLanguage", () => {
  test("detects Spanish", () => {
    expect(detectLanguage("Hola, ¿cómo estás? Esta es la respuesta que necesitas para el proyecto.")).toBe("es");
  });
  test("detects English", () => {
    expect(detectLanguage("Here is the answer that you need for the project, and it works.")).toBe("en");
  });
  test("accented characters push toward Spanish", () => {
    expect(detectLanguage("Configuración lista")).toBe("es");
  });
  test("short ambiguous text falls back to English", () => {
    expect(detectLanguage("ok")).toBe("en");
  });
  test("empty text falls back to English", () => {
    expect(detectLanguage("")).toBe("en");
  });
  test("mixed text follows the dominant language", () => {
    expect(detectLanguage("El servidor responde con el JSON y la API de la aplicación está lista para usar")).toBe("es");
  });
});

describe("prepareSpeech", () => {
  test("removes fenced code blocks", () => {
    expect(prepareSpeech("Antes\n```ts\nconst a = 1;\n```\nDespués")).toBe("Antes\nDespués");
  });
  test("keeps inline code content without backticks", () => {
    expect(prepareSpeech("Run `bun test` now")).toBe("Run bun test now");
  });
  test("replaces links with their label", () => {
    expect(prepareSpeech("See [the docs](https://example.com/a) here")).toBe("See the docs here");
  });
  test("drops bare URLs", () => {
    expect(prepareSpeech("Visit https://example.com/path?x=1 today")).toBe("Visit today");
  });
  test("strips headings, emphasis, quotes and list markers", () => {
    expect(prepareSpeech("# Title\n**bold** and _it_\n> quote\n- item\n1. one")).toBe("Title\nbold and it\nquote\nitem\none");
  });
  test("drops images", () => {
    expect(prepareSpeech("A ![alt](x.png) B")).toBe("A B");
  });
  test("removes html tags", () => {
    expect(prepareSpeech("a <b>bold</b> c")).toBe("a bold c");
  });
  test("converts tables to plain cells", () => {
    expect(prepareSpeech("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a b\n1 2");
  });
  test("collapses whitespace and blank lines", () => {
    expect(prepareSpeech("a   b\n\n\n\nc  ")).toBe("a b\nc");
  });
  test("returns empty when only code remains", () => {
    expect(prepareSpeech("```\ncode\n```")).toBe("");
  });
  test("truncates at a sentence boundary under the limit", () => {
    const text = "One sentence. ".repeat(50);
    const out = prepareSpeech(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(".")).toBe(true);
  });
});
