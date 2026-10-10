import { appendFileSync } from "node:fs";
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { selectFinalResponse, validID, type MessageData, type Selection } from "./final-response";
import { defaultKokoroEngine } from "./kokoro-engine";
import { defaultPiperEngine } from "./piper-engine";
import { createConfigReader } from "./config";
import { createSpeechSink, sapiEngine, type Engine, type SpeechSink } from "./speech-sink";

type Result<T> = { data?: T; error?: unknown };
export type Client = {
  session: {
    get(input: { path: { id: string }; query: { directory: string } }): Promise<Result<import("@opencode-ai/sdk").Session>>;
    message(input: { path: { id: string; messageID: string }; query: { directory: string } }): Promise<Result<MessageData>>;
  };
};
export type Sink = (selection: Selection) => Promise<void>;
type State = {
  turn?: string;
  created: number;
  generation: number;
  users: Set<string>;
  claimed: Set<string>;
  blocked: boolean;
};

export function createCoordinator(client: Client, directory: string, sink: Sink = async () => {}) {
  const sessions = new Map<string, State>();
  let disposed = false;
  const invalidate = (state: State) => {
    state.generation++;
    state.turn = undefined;
  };
  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    // The host does not await event hooks. All SDK and sink failures stay here.
    try {
      if (disposed) return;
      if (event.type === "session.error") {
        if (event.properties.sessionID === undefined) sessions.forEach(invalidate);
        else {
          const state = sessions.get(event.properties.sessionID);
          if (state) invalidate(state);
        }
        return;
      }
      if (event.type === "session.deleted" || event.type === "message.removed") {
        const id = event.type === "session.deleted" ? event.properties.info.id : event.properties.sessionID;
        const state = sessions.get(id);
        if (state) {
          invalidate(state);
          if (event.type === "session.deleted") state.blocked = true;
        }
        return;
      }
      if (event.type !== "message.updated") return;
      const info = event.properties.info;
      if (!info || !validID(info.id) || !validID(info.sessionID)) return;
      let state = sessions.get(info.sessionID);
      if (info.role === "user") {
        if (!Number.isFinite(info.time?.created) || info.summary !== undefined) return;
        if (!state) {
          // No eviction: eviction would allow delayed historical events to look fresh.
          if (sessions.size >= 128) return;
          state = { created: -Infinity, generation: 0, users: new Set(), claimed: new Set(), blocked: false };
          sessions.set(info.sessionID, state);
        }
        if (state.blocked || state.users.has(info.id) || info.time.created <= state.created) return;
        invalidate(state);
        if (state.users.size >= 64) { state.blocked = true; return; }
        state.users.add(info.id);
        state.turn = info.id;
        state.created = info.time.created;
        return;
      }
      if (info.role !== "assistant" || !state || state.blocked) return;
      if (info.error !== undefined) { invalidate(state); return; }
      if (!state.turn || info.parentID !== state.turn || info.finish !== "stop" ||
          !Number.isFinite(info.time?.completed) || state.claimed.has(info.id)) return;
      if (state.claimed.size >= 256) { invalidate(state); state.blocked = true; return; }
      state.claimed.add(info.id); // Claim synchronously, before the first await.
      const generation = state.generation;
      const current = () => !disposed && !state!.blocked && state!.generation === generation;
      const session = await client.session.get({ path: { id: info.sessionID }, query: { directory } });
      if (!current() || session.error !== undefined || !session.data) return;
      const response = await client.session.message({ path: { id: info.sessionID, messageID: info.id }, query: { directory } });
      if (!current() || response.error !== undefined || !response.data ||
          response.data.info.id !== info.id || response.data.info.sessionID !== info.sessionID ||
          session.data.id !== info.sessionID) return;
      const parent = await client.session.message({ path: { id: info.sessionID, messageID: info.parentID }, query: { directory } });
      if (!current() || parent.error !== undefined || !parent.data ||
          parent.data.info.id !== state.turn || parent.data.info.time.created !== state.created) return;
      const selection = selectFinalResponse(session.data, response.data, parent.data);
      if (selection && current()) await sink(selection);
    } catch {
      // Claimed messages remain claimed after failures; there is no automatic retry.
    }
  };
  return {
    event,
    dispose: () => { disposed = true; sessions.clear(); },
  };
}


export function createAgentVoz(client: Client, directory: string, sink: SpeechSink, isPaused?: () => boolean): Hooks {
  const coordinator = createCoordinator(client, directory, sink);
  const seenUsers = new Set<string>();
  let wasPaused = false;
  const event: NonNullable<Hooks["event"]> = async (input) => {
    try {
      // Pausing cuts the current narration once; resuming needs no action.
      const paused = isPaused?.() ?? false;
      if (paused && !wasPaused) sink.stop();
      wasPaused = paused;
      // A NEW user turn or a session error makes any current narration stale.
      // The host repeats updates for the same user message; those must not cancel speech.
      const { event } = input;
      if (event.type === "session.error") sink.stop();
      else if (event.type === "message.updated" && event.properties.info?.role === "user") {
        const id = event.properties.info.id;
        if (!seenUsers.has(id)) {
          if (seenUsers.size >= 1024) seenUsers.clear();
          seenUsers.add(id);
          sink.stop();
        }
      }
    } catch {}
    await coordinator.event(input);
  };
  return { event };
}

/** Skips new narrations while paused; stop() always passes through. */
export function withPause(sink: SpeechSink, isPaused: () => boolean): SpeechSink {
  const wrapped = (async (selection: Selection) => {
    if (isPaused()) return;
    await sink(selection);
  }) as SpeechSink;
  wrapped.stop = () => sink.stop();
  return wrapped;
}

function debugLog(file: string | undefined) {
  return (message: string) => {
    if (!file) return;
    try { appendFileSync(file, `${new Date().toISOString()} ${message}\n`); } catch {}
  };
}

type Factories = { kokoro: () => Engine | undefined; piper: () => Engine | undefined };

/** auto = Kokoro, then Piper, then Windows SAPI (engine left undefined). */
export function chooseEngine(
  wanted: string,
  enabled: boolean,
  factories: Factories = { kokoro: () => defaultKokoroEngine(), piper: () => defaultPiperEngine() },
): { name: "kokoro" | "piper" | "sapi"; engine: Engine | undefined } {
  if (!enabled || wanted === "sapi") return { name: "sapi", engine: undefined };
  if (wanted === "kokoro" || wanted === "auto") {
    const kokoro = factories.kokoro();
    if (kokoro) return { name: "kokoro", engine: kokoro };
  }
  if (wanted === "piper" || wanted === "auto" || wanted === "kokoro") {
    const piper = factories.piper();
    if (piper) return { name: "piper", engine: piper };
  }
  return { name: "sapi", engine: undefined };
}

/** Re-chooses the engine on every utterance so `agentvoz engine ...` applies without a restart. */
export function liveEngine(
  wanted: () => string,
  factories: Factories,
  fallback: Engine = sapiEngine(),
  onChoice?: (name: string) => void,
): Engine {
  let last = "";
  return (text, language) => {
    const choice = chooseEngine(wanted(), true, factories);
    if (choice.name !== last) { last = choice.name; onChoice?.(choice.name); }
    return (choice.engine ?? fallback)(text, language);
  };
}

const memo = <T>(make: () => T | undefined) => {
  let value: T | undefined;
  return () => (value ??= make());
};

export const AgentVozPlugin: Plugin = async ({ client, directory }) => {
  const log = debugLog(process.env.AGENTVOZ_LOG);
  const enabled = process.env.AGENTVOZ_DISABLED !== "1" && process.platform === "win32";
  const config = createConfigReader();
  const factories: Factories = {
    kokoro: memo(() => defaultKokoroEngine(process.env, config)),
    piper: memo(() => defaultPiperEngine()),
  };
  const wanted = () => (process.env.AGENTVOZ_ENGINE ?? config().engine).toLowerCase();
  const sink = createSpeechSink({
    enabled,
    engine: liveEngine(wanted, factories, sapiEngine(), (name) => log(`engine=${name}`)),
    onError: (error) => log(`speech error: ${error instanceof Error ? error.message : String(error)}`),
  });
  log(`plugin ready enabled=${enabled}`);
  const isPaused = () => config().paused;
  const logged = (async (selection: Selection) => {
    log(`selection session=${selection.sessionID} message=${selection.messageID} chars=${selection.text.length} paused=${isPaused()}`);
    await sink(selection);
  }) as SpeechSink;
  logged.stop = () => sink.stop();
  const traced: Client = process.env.AGENTVOZ_LOG ? {
    session: {
      get: async (input) => {
        try { const r = await client.session.get(input as never); log(`session.get ${r.error ? "error" : "ok"}`); return r as never; }
        catch (error) { log(`session.get threw ${String(error)}`); throw error; }
      },
      message: async (input) => {
        try { const r = await client.session.message(input as never); log(`session.message ${r.error ? "error" : "ok"}`); return r as never; }
        catch (error) { log(`session.message threw ${String(error)}`); throw error; }
      },
    },
  } : (client as unknown as Client);
  return createAgentVoz(traced, directory, withPause(logged, isPaused), isPaused);
};
