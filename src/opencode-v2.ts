// OpenCode V2 entrypoint. The V2 loader requires `export default { id, setup }` and gives
// server plugins no raw SDK client, so this adapter translates V2 session events and
// `session.get`/`session.context` into the V1 shapes the tested coordinator already
// consumes. Freshness and fail-closed selection stay in `plugin.ts`/`final-response.ts`.
import type { Event, Session } from "@opencode-ai/sdk";
import type { Hooks } from "@opencode-ai/plugin";
import type { MessageData } from "./final-response";
import { createPluginHooks, type Client } from "./plugin";
import { OPEN_VOX_RPC } from "./rpc";

type V2Event = { type?: string; data?: any; location?: { directory?: string } };
export type V2Session = {
  get(input: { sessionID: string }): Promise<any>;
  context(input: { sessionID: string }): Promise<any[]>;
};
type V2Registration = { events: { emit(name: "command", data: { command: string }): Promise<void> }; dispose(): Promise<void> | void };
export type V2Context = {
  location: { directory: string };
  session: V2Session;
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<any> };
  rpc: { register(definition: typeof OPEN_VOX_RPC, handlers: { command(input: { command: string }, context: unknown): Promise<object> }): Promise<V2Registration> };
};
type HooksFactory = (client: Client, directory: string, publish: (command: string) => Promise<void>) => Hooks;

/** Mirrors the V1 `messages` page size; `selectLatestPersisted` rejects larger histories. */
const HISTORY_LIMIT = 100;

const ok = <T>(data: T) => ({ data });
const failed = (error: unknown) => ({ error });

/** V2 messages carry no `parentID`: a response belongs to the nearest preceding user message. */
export function v1Messages(sessionID: string, entries: unknown): MessageData[] {
  if (!Array.isArray(entries)) return [];
  const messages: MessageData[] = [];
  let parent = "";
  for (const entry of entries) {
    if (entry?.type === "user") {
      parent = entry.id;
      const text = typeof entry.text === "string" && entry.text ? [{ id: `${entry.id}:text`, sessionID, messageID: entry.id, type: "text", text: entry.text }] : [];
      messages.push({ info: { id: entry.id, sessionID, role: "user", time: { created: entry.time?.created } }, parts: text } as unknown as MessageData);
    } else if (entry?.type === "assistant") {
      const content: any[] = Array.isArray(entry.content) ? entry.content : [];
      const parts = content.map((part, index) => ({
        id: `${entry.id}:${index}`, sessionID, messageID: entry.id, type: part?.type,
        ...(part?.type === "text" ? { text: part.text } : {}),
      }));
      messages.push({ info: {
        id: entry.id, sessionID, role: "assistant", parentID: parent, finish: entry.finish, error: entry.error,
        time: { created: entry.time?.created, completed: entry.time?.completed },
      }, parts } as unknown as MessageData);
    }
  }
  return messages;
}

function v1Session(info: any, compacting: number | undefined): Session {
  const time = { created: info?.time?.created, updated: info?.time?.updated, ...(compacting === undefined ? {} : { compacting }) };
  return { id: info?.id, parentID: info?.parentID, revert: info?.revert, time } as Session;
}

/** One adapter per plugin instance: it owns the compaction state V2 reports only as events. */
export function createV2Bridge(session: V2Session, directory: string) {
  const compacting = new Map<string, number>();
  const history = async (sessionID: string) => v1Messages(sessionID, await session.context({ sessionID }));
  const client: Client = { session: {
    get: async ({ path }) => {
      try { return ok(v1Session(await session.get({ sessionID: path.id }), compacting.get(path.id))) as never; }
      catch (error) { return failed(error) as never; }
    },
    message: async ({ path }) => {
      try {
        const found = (await history(path.id)).find(message => message.info.id === path.messageID);
        return (found ? ok(found) : failed(new Error("message not found"))) as never;
      } catch (error) { return failed(error) as never; }
    },
    messages: async ({ path, query }) => {
      try { return ok((await history(path.id)).slice(-Math.min(query.limit, HISTORY_LIMIT))) as never; }
      catch (error) { return failed(error) as never; }
    },
  } };

  const updated = (message: MessageData): Event => ({ type: "message.updated", properties: { info: message.info } } as Event);
  /** The latest user turn and, when requested, only its last response: earlier steps are not final. */
  const turn = async (sessionID: string, withResponse: boolean): Promise<Event[]> => {
    let messages: MessageData[];
    try { messages = await history(sessionID); } catch { return []; }
    const roles = messages.map(message => message.info.role);
    const start = roles.lastIndexOf("user");
    if (start < 0) return [];
    const events = [updated(messages[start])];
    const last = roles.lastIndexOf("assistant");
    const response = last > start ? messages[last] : undefined;
    if (withResponse && response) events.push(updated(response));
    return events;
  };

  const translate = async (event: V2Event): Promise<Event[]> => {
    if (event?.location?.directory && event.location.directory !== directory) return [];
    const sessionID = event?.data?.sessionID;
    if (typeof sessionID !== "string" || !sessionID) return [];
    const v1 = (type: string, properties: unknown) => [{ type, properties } as Event];
    switch (event.type) {
      case "session.execution.started": return turn(sessionID, false);
      case "session.execution.succeeded": return turn(sessionID, true);
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.step.failed": return v1("session.error", { sessionID });
      case "session.deleted": compacting.delete(sessionID); return v1("session.deleted", { info: { id: sessionID } });
      case "session.revert.staged":
      case "session.revert.committed": return v1("message.removed", { sessionID });
      case "session.compaction.started": {
        const since = Date.now();
        compacting.set(sessionID, since);
        return v1("session.updated", { info: { id: sessionID, time: { compacting: since } } });
      }
      case "session.compaction.ended":
      case "session.compaction.failed": compacting.delete(sessionID); return v1("session.compacted", { sessionID });
      case "session.step.started": return v1("message.part.updated", { part: { sessionID } });
      default: return [];
    }
  };
  return { client, translate };
}

// The V2 event stream ends or throws when the server restarts; reconnect with a bounded
// doubling delay that resets once real events flow again.
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 5000;
const delay = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});

export async function setupOpenVoxV2(ctx: V2Context, factory: HooksFactory = createPluginHooks): Promise<() => Promise<void>> {
  const directory = ctx.location.directory;
  const bridge = createV2Bridge(ctx.session, directory);
  let registration: V2Registration | undefined;
  const hooks = factory(bridge.client, directory, async (command) => {
    if (!registration) throw new Error("Repeat status transport failed");
    await registration.events.emit("command", { command });
  });
  // Like the V1 host, events are not awaited: a slow fetch must not delay later cancellations.
  const forward = (event: Event) => { void Promise.resolve(hooks.event?.({ event })).catch(() => {}); };
  const abort = new AbortController();
  let listening: Promise<void> = Promise.resolve();
  const cleanup = async () => {
    abort.abort();
    try { await registration?.dispose(); } catch {}
    await listening;
    await hooks.dispose?.();
  };
  try {
    registration = await ctx.rpc.register(OPEN_VOX_RPC, {
      command: async ({ command }) => {
        forward({ type: "tui.command.execute", properties: { command } } as Event);
        return {};
      },
    });
    listening = (async () => {
      let retryMs = RETRY_MIN_MS;
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (abort.signal.aborted) break;
            if (event?.type !== "server.connected") retryMs = RETRY_MIN_MS;
            try { for (const translated of await bridge.translate(event)) forward(translated); } catch {}
          }
        } catch {
          // Events missed while disconnected are lost; the next turn starts fresh.
        }
        if (abort.signal.aborted) break;
        await delay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    })();
  } catch (cause) {
    await cleanup();
    throw cause;
  }
  return cleanup;
}

export default { id: "open-vox", setup: (ctx: V2Context) => setupOpenVoxV2(ctx) };
