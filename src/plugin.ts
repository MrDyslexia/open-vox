import { envValue } from "./brand";
import { appendFileSync } from "node:fs";
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { selectFinalResponse, validID, type MessageData, type Selection } from "./final-response";
import { defaultKokoroEngine } from "./kokoro-engine";
import { defaultPiperEngine } from "./piper-engine";
import { createConfigReader, readConfig, type ConfigReader } from "./config";
import { createSpeechSink, sapiEngine, type Engine, type SpeechSink, type SpeechSinkOptions } from "./speech-sink";
import { createPlayer } from "./player";
import { AudioCache, type AudioStore } from "./audio-cache";
import { createRepeatControl } from "./repeat-control";

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


export function createOpenVox(client: Client, directory: string, sink: SpeechSink, isPaused?: () => boolean,
  controlOptions?: { publish: (command: string) => Promise<void>; instance?: string }): Hooks {
  const coordinator = createCoordinator(client, directory, sink);
  const control = controlOptions && createRepeatControl({ ...controlOptions,
    status: () => sink.status?.(), isPaused: () => isPaused?.() ?? false,
    repeat: async (sessionID, revision, expires) => { await sink.repeat?.(sessionID, revision, expires); } });
  const seenUsers = new Set<string>();
  let wasPaused = false;
  let disposed = false;
  const event: NonNullable<Hooks["event"]> = async (input) => {
    if (disposed) return;
    if (input.event.type === "tui.command.execute" && await control?.handle(input.event.properties.command)) return;
    try {
      // Pausing cuts the current narration once; resuming needs no action.
      const paused = isPaused?.() ?? false;
      if (paused && !wasPaused) sink.stop();
      wasPaused = paused;
      // A NEW user turn or a session error makes any current narration stale.
      // The host repeats updates for the same user message; those must not cancel speech.
      const { event } = input;
      if (event.type === "session.error") sink.stop();
      else if (event.type === "session.deleted") sink.removeSession?.(event.properties.info.id);
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
  return { event, dispose: async () => {
    if (disposed) return;
    disposed = true; control?.dispose(); coordinator.dispose(); seenUsers.clear();
    try { sink.stop(); } finally { await sink.dispose?.(); }
  } };
}

/** Skips new narrations while paused; stop() always passes through. */
export function withPause(sink: SpeechSink, isPaused: () => boolean): SpeechSink {
  const wrapped = (async (selection: Selection) => {
    if (isPaused()) return;
    await sink(selection);
  }) as SpeechSink;
  wrapped.stop = () => sink.stop();
  wrapped.status = () => sink.status?.();
  wrapped.repeat = async (sessionID, revision, expires) => { if (!isPaused()) await sink.repeat?.(sessionID, revision, expires); };
  wrapped.removeSession = (sessionID) => sink.removeSession?.(sessionID);
  wrapped.dispose = async () => { await sink.dispose?.(); };
  return wrapped;
}

/**
 * Cuts the audio that is playing the moment pause flips on. Host events are not enough:
 * while narration plays the host is usually idle, so nothing would call stop() until later.
 * Returns a function that stops the watcher.
 */
export function watchPause(sink: SpeechSink, isPaused: () => boolean, intervalMs = 250): () => void {
  let wasPaused = isPaused();
  const timer = setInterval(() => {
    try {
      const paused = isPaused();
      if (paused && !wasPaused) sink.stop();
      wasPaused = paused;
    } catch {}
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
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

/** Re-chooses the engine on every utterance so `open-vox engine ...` applies without a restart. */
export function liveEngine(
  wanted: () => string,
  factories: Factories,
  fallback: Engine = sapiEngine(),
  onChoice?: (name: string) => void,
): Engine {
  let last = "";
  const select = () => {
    const choice = chooseEngine(wanted(), true, factories);
    if (choice.name !== last) { last = choice.name; onChoice?.(choice.name); }
    return choice.engine ?? fallback;
  };
  const engine: Engine = (text, language) => select()(text, language);
  engine.synthesize = (text, language, wav) => {
    const selected = select();
    if (!selected.synthesize) throw new Error("Selected engine cannot generate audio");
    return selected.synthesize(text, language, wav);
  };
  return engine;
}

const memo = <T>(make: () => T | undefined) => {
  let value: T | undefined;
  return () => (value ??= make());
};

/** Builds the narration sink; engine, voice and speed are re-read from the shared config on every utterance. */
export function createLiveSink(
  env: Record<string, string | undefined>,
  config: ConfigReader,
  log: (message: string) => void,
  enabled = envValue(env, "DISABLED") !== "1" && process.platform === "win32",
  audio?: { cache: AudioStore; isPaused: () => boolean } & Pick<SpeechSinkOptions, "player" | "playbackTimeoutMs">,
): SpeechSink {
  const factories: Factories = {
    kokoro: memo(() => defaultKokoroEngine(env, config)),
    piper: memo(() => defaultPiperEngine(env)),
  };
  const wanted = () => (envValue(env, "ENGINE") ?? config().engine).toLowerCase();
  return createSpeechSink({
    enabled,
    ...audio,
    engine: liveEngine(wanted, factories, sapiEngine(), (name) => log(`engine=${name}`)),
    onError: (error) => log(`speech error: ${error instanceof Error ? error.message : String(error)}`),
  });
}

/** Speaks one text with the current settings and waits for it to finish (used by `open-vox say`). */
export async function speakOnce(text: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const errors: string[] = [];
  const sink = createLiveSink(env, createConfigReader(() => readConfig(), 0), (m) => { if (m.startsWith("speech error")) errors.push(m); });
  await sink({ sessionID: "cli", messageID: "cli", text });
  if (errors.length > 0) throw new Error(errors.join("; "));
}

/** The player watches each playback by its own duration; this is only a last-resort ceiling for the sink. */
const PLAYBACK_BACKSTOP_MS = 30 * 60_000;

export const OpenVoxPlugin: Plugin = async ({ client, directory }) => {
  const log = debugLog(envValue(process.env, "LOG"));
  let enabled = envValue(process.env, "DISABLED") !== "1" && process.platform === "win32";
  const config = createConfigReader();
  const isPaused = () => { config.invalidate(); return config().paused; };
  let cache: AudioCache | undefined;
  if (enabled) {
    try { cache = new AudioCache(); }
    catch { enabled = false; log("audio cache unavailable; narration disabled"); }
  }
  // One persistent player host per plugin instance; it starts lazily on the first cached playback.
  const player = cache ? createPlayer({ log: (message) => log(message) }) : undefined;
  const sink = createLiveSink(process.env, config, log, enabled, cache && player
    ? { cache, isPaused, player: (wav) => player.play(wav), playbackTimeoutMs: PLAYBACK_BACKSTOP_MS }
    : undefined);
  log(`plugin ready enabled=${enabled}`);
  const stopWatcher = watchPause(sink, isPaused);
  const logged = (async (selection: Selection) => {
    log(`selection session=${selection.sessionID} message=${selection.messageID} chars=${selection.text.length} paused=${isPaused()}`);
    await sink(selection);
  }) as SpeechSink;
  logged.stop = () => sink.stop();
  logged.repeat = sink.repeat;
  logged.status = sink.status;
  logged.removeSession = sink.removeSession;
  logged.dispose = sink.dispose;
  const traced: Client = envValue(process.env, "LOG") ? {
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
  const hooks = createOpenVox(traced, directory, withPause(logged, isPaused), isPaused, {
    instance: cache?.instance,
    publish: async (command) => {
      const result = await client.tui.publish({ query: { directory },
        body: { type: "tui.command.execute", properties: { command } }, signal: AbortSignal.timeout(2000) });
      if (result.error || !result.data) throw new Error("Repeat status transport failed");
    },
  });
  return { ...hooks, dispose: async () => {
    stopWatcher();
    try { await hooks.dispose?.(); } finally { await player?.dispose(); }
  } };
};
