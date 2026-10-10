import type { Message, Part, Session } from "@opencode-ai/sdk";

export type MessageData = { info: Message; parts: Part[] };
export type Selection = { sessionID: string; messageID: string; text: string };

export const validID = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function permittedText(data: MessageData): string | undefined {
  if (!Array.isArray(data.parts)) return undefined;
  const ids = new Set<string>();
  const text: string[] = [];
  for (const part of data.parts) {
    if (!part || !validID(part.id) || ids.has(part.id) ||
        part.sessionID !== data.info.sessionID || part.messageID !== data.info.id) return undefined;
    ids.add(part.id);
    if (part.type === "compaction") return undefined;
    if (part.type === "text") {
      if (typeof part.text !== "string" ||
          (part.synthetic !== undefined && typeof part.synthetic !== "boolean") ||
          (part.ignored !== undefined && typeof part.ignored !== "boolean")) return undefined;
      if (!part.synthetic && !part.ignored && part.text.trim()) text.push(part.text.trim());
    } else if (!["reasoning", "tool", "file", "step-start", "step-finish", "snapshot", "patch", "agent", "retry", "subtask"].includes(part.type)) {
      return undefined;
    }
  }
  return text.length ? text.join("\n\n") : undefined;
}

export function selectFinalResponse(
  session: Session,
  response: MessageData,
  parent: MessageData,
): Selection | undefined {
  const info = response?.info;
  const user = parent?.info;
  if (!session || !info || !user || !validID(session.id) || session.parentID !== undefined ||
      session.time?.compacting !== undefined || session.revert !== undefined ||
      info.role !== "assistant" || user.role !== "user" ||
      !validID(info.id) || !validID(user.id) || info.id === user.id ||
      info.sessionID !== session.id || user.sessionID !== session.id || info.parentID !== user.id ||
      info.error !== undefined || (info.summary !== undefined && info.summary !== false) ||
      // The host attaches a diff-summary OBJECT to user messages after a turn; only a non-object is malformed.
      (user.summary !== undefined && (typeof user.summary !== "object" || user.summary === null)) || info.finish !== "stop" ||
      !Number.isFinite(info.time?.created) || !Number.isFinite(info.time?.completed) ||
      !Number.isFinite(user.time?.created) || info.time.created < user.time.created ||
      info.time.completed! < info.time.created) return undefined;
  const text = permittedText(response);
  if (!text || !permittedText(parent) || parent.parts.some(part =>
    part.type === "text" && (part.synthetic || part.ignored))) return undefined;
  return { sessionID: session.id, messageID: info.id, text };
}
