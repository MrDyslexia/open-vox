import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Part, Session, UserMessage } from "@opencode-ai/sdk";
import { selectFinalResponse, type MessageData } from "../src/final-response";

export function fixture(sessionID = "s", userID = "u", messageID = "a") {
  const session: Session = {
    id: sessionID, projectID: "p", directory: "local", title: "Test", version: "1",
    time: { created: 1, updated: 2 },
  };
  const user: UserMessage = {
    id: userID, sessionID, role: "user", time: { created: 1 }, agent: "test",
    model: { providerID: "fake", modelID: "fake" },
  };
  const assistant: AssistantMessage = {
    id: messageID, sessionID, role: "assistant", parentID: userID,
    time: { created: 2, completed: 3 }, finish: "stop", modelID: "fake",
    providerID: "fake", mode: "test", path: { cwd: "local", root: "local" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const text = (id: string, owner: string, value: string): Part => ({
    id, sessionID, messageID: owner, type: "text", text: value,
  });
  return {
    session,
    parent: { info: user, parts: [text("up", userID, "Question")] } as MessageData,
    response: { info: assistant, parts: [text("ap", messageID, " Answer ")] } as MessageData,
  };
}

describe("conservative final response", () => {
  test("selects eligible prose", () => {
    const f = fixture();
    expect(selectFinalResponse(f.session, f.response, f.parent)).toEqual({ sessionID: "s", messageID: "a", text: "Answer" });
  });
  test.each(["tool-calls", "length", "unknown", undefined])("rejects finish %s", (finish) => {
    const f = fixture();
    if (f.response.info.role === "assistant") f.response.info.finish = finish;
    expect(selectFinalResponse(f.session, f.response, f.parent)).toBeUndefined();
  });
  test.each([undefined, NaN, Infinity])("rejects invalid completion %s", (completed) => {
    const f = fixture();
    f.response.info.time = { created: 2, completed };
    expect(selectFinalResponse(f.session, f.response, f.parent)).toBeUndefined();
  });
  test.each(["error", "summary", "child", "user", "parent", "session", "part", "empty", "synthetic", "ignored", "compaction", "reasoning", "tool", "parent-synthetic", "parent-compaction", "duplicate-part", "blank-id", "unknown-part", "blank-text", "parent-role", "parent-summary", "compacting", "revert", "bad-flag", "backwards-time"])("rejects %s", (kind) => {
    const f = fixture();
    const info = f.response.info as AssistantMessage;
    if (kind === "error") info.error = { name: "MessageAbortedError", data: { message: "Aborted" } };
    if (kind === "summary") info.summary = true;
    if (kind === "child") f.session.parentID = "root";
    if (kind === "user") f.response.info = f.parent.info;
    if (kind === "parent") info.parentID = "other";
    if (kind === "session") f.parent.info.sessionID = "other";
    if (kind === "part") f.response.parts[0].messageID = "other";
    if (kind === "empty") f.response.parts = [];
    if (kind === "synthetic" || kind === "ignored") Object.assign(f.response.parts[0], { [kind]: true });
    if (["compaction", "reasoning", "tool"].includes(kind)) f.response.parts = [{ ...f.response.parts[0], type: kind } as Part];
    if (kind === "parent-synthetic") Object.assign(f.parent.parts[0], { synthetic: true });
    if (kind === "parent-compaction") f.parent.parts = [{ ...f.parent.parts[0], type: "compaction", auto: true } as Part];
    if (kind === "duplicate-part") f.response.parts.push(f.response.parts[0]);
    if (kind === "blank-id") info.id = "";
    if (kind === "unknown-part") f.response.parts[0] = { ...f.response.parts[0], type: "unknown" } as unknown as Part;
    if (kind === "blank-text") Object.assign(f.response.parts[0], { text: "  " });
    if (kind === "parent-role") f.parent.info = info;
    if (kind === "parent-summary" && f.parent.info.role === "user") f.parent.info.summary = { diffs: [] };
    if (kind === "compacting") f.session.time.compacting = 1;
    if (kind === "revert") f.session.revert = { messageID: "u" };
    if (kind === "bad-flag") Object.assign(f.response.parts[0], { ignored: "false" });
    if (kind === "backwards-time") info.time.completed = 1;
    expect(selectFinalResponse(f.session, f.response, f.parent)).toBeUndefined();
  });
  test("excludes reasoning and flagged text from mixed prose", () => {
    const f = fixture();
    f.response.parts.push(
      { id: "r", sessionID: "s", messageID: "a", type: "reasoning", text: "private", time: { start: 1 } },
      { id: "x", sessionID: "s", messageID: "a", type: "text", text: "hidden", ignored: true },
    );
    expect(selectFinalResponse(f.session, f.response, f.parent)?.text).toBe("Answer");
  });
});
