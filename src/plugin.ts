import { envValue } from "./brand";
import { appendFileSync } from "node:fs";
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { selectFinalResponse, selectLatestPersisted, validID, type MessageData, type Selection } from "./final-response";
import { defaultKokoroEngine } from "./kokoro-engine";
import { defaultPiperEngine } from "./piper-engine";
import { createConfigReader, readConfig, type ConfigReader } from "./config";
import { createSpeechSink, sapiEngine, type Engine, type SpeechSink, type SpeechSinkOptions } from "./speech-sink";
import { createPlayer } from "./player";
import { AudioCache, type AudioStore } from "./audio-cache";
import { createRepeatControl, isPlaybackSpeed, speedOfAction, type PlaybackSpeed } from "./repeat-control";
import { flattenNarrationPlan } from "./narration-plan";

type Result<T> = { data?: T; error?: unknown };
export type Client = {
  session: {
    get(input: { path: { id: string }; query: { directory: string }; signal?: AbortSignal }): Promise<Result<import("@opencode-ai/sdk").Session>>;
    message(input: { path: { id: string; messageID: string }; query: { directory: string } }): Promise<Result<MessageData>>;
    messages?(input: { path: { id: string }; query: { directory: string; limit: number }; signal?: AbortSignal }): Promise<Result<MessageData[]>>;
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

type CoordinatorOptions = {
  isPaused?: () => boolean;
  isEnabled?: () => boolean;
  /** Runs when affected sessions lose their current work; `sessionID` is undefined for unscoped errors. */
  onInvalidate?: (sessionID?: string, deleted?: boolean) => void;
};

export function createCoordinator(client: Client, directory: string, sink: Sink = async () => {}, options: CoordinatorOptions = {}) {
  const sessions = new Map<string, State>();
  let disposed = false;
  // Latest manual target is independent of the consumable paused slot (never a backlog).
  let epoch = 0, sequence = 0;
  let resumedThrough = 0;
  let latest: { completed: number; sequence: number } | undefined;
  let pending: { selection: Selection; current: () => boolean } | undefined;
  let target: typeof pending;
  // Manual discovery owns one displayed-session slot, not the observed-turn autoplay state.
  let displayed: string | undefined, discoveryEpoch = 0, recovered = false;
  let cachedUntil = 0, reading: Promise<boolean> | undefined;
  let discoveryAbort: AbortController | undefined;
  const recoveryBlocked = new Set<string>();
  const resetDiscovery = (resetCooldown = true) => {
    discoveryEpoch++;
    if (resetCooldown) cachedUntil = 0;
    discoveryAbort?.abort();
    if (recovered) target = undefined;
    recovered = false;
  };
  const view = (sessionID: string) => {
    if (displayed === sessionID) return;
    resetDiscovery(); displayed = sessionID;
  };
  const refresh = async (sessionID: string, force = false) => {
    if (!client.session.messages) return true; // Older embedders keep observed-response-only behavior.
    if (disposed || !enabled() || options.isPaused?.() || displayed !== sessionID ||
        recoveryBlocked.has(sessionID) || recoveryBlocked.size >= 128 || sessions.get(sessionID)?.blocked) return false;
    const requestedEpoch = discoveryEpoch;
    if (reading) return await reading && requestedEpoch === discoveryEpoch;
    if (target?.current() && busy.has(selectionKey(target.selection))) return true;
    if (!force && Date.now() < cachedUntil) return true;
    const version = discoveryEpoch, serviceEpoch = epoch;
    const state = sessions.get(sessionID), generation = state?.generation;
    const current = () => !disposed && enabled() && !options.isPaused?.() && displayed === sessionID &&
      version === discoveryEpoch && serviceEpoch === epoch && state?.generation === generation;
    const abort = new AbortController(); discoveryAbort = abort;
    cachedUntil = Date.now() + 5000; // Positive, negative and failed reads share a bounded polling cooldown.
    reading = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.all([
            client.session.get({ path: { id: sessionID }, query: { directory }, signal: abort.signal }),
            client.session.messages!({ path: { id: sessionID }, query: { directory, limit: 100 }, signal: abort.signal }),
          ]),
          new Promise<undefined>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(undefined); }, 1500); }),
        ]);
        if (!current()) return false;
        // Revalidation replaces only the manual target, never the Pause pending slot.
        target = undefined; recovered = false;
        if (!result) return false;
        const [session, history] = result;
        if (session.error !== undefined || history.error !== undefined || session.data?.id !== sessionID || !history.data) return false;
        const messages = history.data;
        const selection = selectLatestPersisted(session.data, messages);
        if (!selection) return false;
        const response = messages.find(m => m.info.id === selection.messageID)!.info;
        const parent = messages.find(m => response.role === "assistant" && m.info.id === response.parentID)!.info;
        if (state && (parent.time.created < state.created ||
            (parent.time.created === state.created && parent.id !== state.turn))) return false;
        target = { selection, current }; recovered = true;
        return true;
      } catch {
        if (current()) { target = undefined; recovered = false; }
        return false;
      } finally { if (timer) clearTimeout(timer); }
    })();
    try { return await reading; } finally { reading = undefined; }
  };
  const selectionKey = (selection: Selection) => JSON.stringify([selection.sessionID, selection.messageID]);
  const busy = new Set<string>();
  const deliver = async (selection: Selection) => {
    const key = selectionKey(selection);
    if (busy.has(key)) return;
    busy.add(key);
    try { await sink(selection); } finally { busy.delete(key); }
  };
  const enabled = () => options.isEnabled?.() ?? true;
  const clearPending = () => { resetDiscovery(); epoch++; pending = undefined; target = undefined; latest = undefined; resumedThrough = 0; };
  const cancel = (sessionID?: string, deleted = false) => {
    if (sessionID === undefined || displayed === sessionID) resetDiscovery();
    if (sessionID !== undefined && recoveryBlocked.size < 128) recoveryBlocked.add(sessionID);
    else if (sessionID === undefined && displayed && recoveryBlocked.size < 128) recoveryBlocked.add(displayed);
    if (sessionID === undefined || pending?.selection.sessionID === sessionID) pending = undefined;
    if (sessionID === undefined || target?.selection.sessionID === sessionID) target = undefined;
    try { options.onInvalidate?.(sessionID, deleted); } catch {}
  };
  const invalidate = (state: State) => {
    state.generation++;
    state.turn = undefined;
  };
  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    // The host does not await event hooks. All SDK and sink failures stay here.
    try {
      if (disposed) return;
      if (event.type === "message.part.updated") {
        if (displayed === event.properties.part.sessionID) resetDiscovery(false);
        return;
      }
      if (event.type === "session.updated") {
        const session = event.properties.info;
        if (displayed === session.id) resetDiscovery(false);
        if (session.revert !== undefined || session.parentID !== undefined || session.time?.compacting !== undefined)
          cancel(session.id);
        return;
      }
      if (event.type === "session.compacted" || event.type === "message.part.removed") {
        const id = event.properties.sessionID;
        const state = sessions.get(id);
        if (state) invalidate(state);
        cancel(id);
        return;
      }
      if (event.type === "session.error") {
        if (event.properties.sessionID === undefined) sessions.forEach(invalidate);
        else {
          const state = sessions.get(event.properties.sessionID);
          if (state) invalidate(state);
        }
        cancel(event.properties.sessionID);
        return;
      }
      if (event.type === "session.deleted" || event.type === "message.removed") {
        const id = event.type === "session.deleted" ? event.properties.info.id : event.properties.sessionID;
        const state = sessions.get(id);
        if (state) {
          invalidate(state);
          if (event.type === "session.deleted") state.blocked = true;
        } else if (event.type === "session.deleted" && sessions.size < 128) {
          sessions.set(id, { created: -Infinity, generation: 0, users: new Set(), claimed: new Set(), blocked: true });
        }
        cancel(id, event.type === "session.deleted");
        return;
      }
      if (event.type !== "message.updated") return;
      const info = event.properties.info;
      if (!info || !validID(info.id) || !validID(info.sessionID)) return;
      let state = sessions.get(info.sessionID);
      if (info.role === "user") {
        // User summaries are SDK diff metadata, unlike the assistant's synthetic-summary flag.
        if (!Number.isFinite(info.time?.created) ||
            (info.summary !== undefined && (typeof info.summary !== "object" || info.summary === null))) return;
        if (!state) {
          // No eviction: eviction would allow delayed historical events to look fresh.
          if (sessions.size >= 128) return;
          state = { created: -Infinity, generation: 0, users: new Set(), claimed: new Set(), blocked: false };
          sessions.set(info.sessionID, state);
        }
        if (state.blocked || state.users.has(info.id) || info.time.created <= state.created) return;
        invalidate(state);
        cancel(info.sessionID);
        recoveryBlocked.delete(info.sessionID);
        if (state.users.size >= 64) { state.blocked = true; return; }
        state.users.add(info.id);
        state.turn = info.id;
        state.created = info.time.created;
        return;
      }
      if (info.role === "assistant" && displayed === info.sessionID) resetDiscovery(false);
      if (info.role === "assistant" && info.error !== undefined) { if (state) invalidate(state); cancel(info.sessionID); return; }
      if (info.role !== "assistant" || !state || state.blocked) return;
      if (!state.turn || info.parentID !== state.turn || info.finish !== "stop" ||
          !Number.isFinite(info.time?.completed) || state.claimed.has(info.id)) return;
      if (state.claimed.size >= 256) { invalidate(state); state.blocked = true; return; }
      state.claimed.add(info.id); // Claim synchronously, before the first await.
      if (!enabled()) return;
      const order = { completed: info.time.completed!, sequence: ++sequence };
      const pausedAtClaim = options.isPaused?.() ?? false;
      const serviceEpoch = epoch;
      const generation = state.generation;
      const current = () => !disposed && enabled() && epoch === serviceEpoch && !state!.blocked && state!.generation === generation;
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
      if (!selection || !current()) return;
      // Completion time, then synchronous claim order: fetch latency never defines freshness.
      // Keep the watermark after consumption so an older paused fetch cannot resurrect on Resume.
      const paused = options.isPaused?.() ?? false;
      if ((pausedAtClaim || paused || order.sequence <= resumedThrough) && latest && (order.completed < latest.completed ||
          (order.completed === latest.completed && order.sequence < latest.sequence))) return;
      if (!latest || order.completed > latest.completed ||
          (order.completed === latest.completed && order.sequence > latest.sequence)) {
        latest = order;
        target = { selection, current };
        recovered = false;
      }
      if (paused) pending = { selection, current };
      else await deliver(selection);
    } catch {
      // Claimed messages remain claimed after failures; there is no automatic retry.
    }
  };
  return {
    event,
    view,
    refresh,
    resetDiscovery,
    deliver,
    latest: () => target?.current() && (displayed === undefined || target.selection.sessionID === displayed)
      ? { selection: target.selection, busy: busy.has(selectionKey(target.selection)) } : undefined,
    /** Consumes the retained paused response once; undefined when none is valid. */
    takePending: () => {
      const retained = pending;
      pending = undefined;
      if (!retained?.current()) return;
      resumedThrough = sequence;
      return retained.selection;
    },
    clearPending,
    dispose: () => { disposed = true; clearPending(); sessions.clear(); },
  };
}


/** Instance-local pause/service state; never persisted to config.json. */
export type PauseState = {
  isPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  /** Instance playback preference; never synthesis speed or persisted config. */
  getPlaybackSpeed: () => PlaybackSpeed;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
};

/**
 * `onPause` runs exactly once per false->true edge and `onResume` exactly once per true->false edge. The
 * flag is already updated when either runs, so queued and in-flight work sees the new state. Both are
 * contained: a failing callback never changes the flag or escapes.
 * Playback rate starts at 1x and survives Pause/Resume and Off/On. Changes while
 * paused are accepted; Off/incapable instances, invalid values and repeats are ignored.
 * The preference is stored before its callback and is not proof of audible application.
 */
export function createPauseState(onPause: () => void, onResume?: () => void,
  service: { onDisable?: () => void; capable?: boolean; onPlaybackSpeed?: (speed: PlaybackSpeed) => void } = {}): PauseState {
  let paused = false, enabled = service.capable !== false, speed: PlaybackSpeed = 1;
  return {
    isPaused: () => paused,
    setPaused(next) {
      // Runtime Off has nothing to pause; unsupported hosts retain legacy pause behavior.
      if (next === paused || (next && !enabled && service.capable !== false)) return;
      paused = next;
      try { (next ? onPause : onResume)?.(); } catch {}
    },
    isEnabled: () => enabled,
    setEnabled(next) {
      if (next === enabled || service.capable === false) return;
      enabled = next;
      if (next) return; // On permits future work; it never resumes discarded audio.
      paused = false;
      try { service.onDisable?.(); } catch {}
    },
    getPlaybackSpeed: () => speed,
    setPlaybackSpeed(next) {
      if (!enabled || next === speed || !isPlaybackSpeed(next)) return;
      speed = next;
      try { service.onPlaybackSpeed?.(next); } catch {}
    },
  };
}

/** Stop owned work before invalidation; a failing step must not skip the next. */
export function disableService(sink: SpeechSink, cache?: Pick<AudioStore, "clear">): void {
  try { sink.stop(); } catch {}
  try { cache?.clear(); } catch {}
}

/** Pause edge of a sink: a real pause when the sink supports it, otherwise the old behavior (stop). */
const pauseSink = (sink: SpeechSink) => (sink.pause ? sink.pause() : sink.stop());

export function createOpenVox(client: Client, directory: string, sink: SpeechSink,
  pause: PauseState = createPauseState(() => pauseSink(sink), () => sink.resume?.(), { onDisable: () => disableService(sink) }),
  controlOptions?: { publish: (command: string) => Promise<void>; instance?: string }): Hooks {
  const coordinator = createCoordinator(client, directory, sink, {
    isPaused: pause.isPaused, isEnabled: pause.isEnabled,
    onInvalidate: (sessionID, deleted) => {
      if (deleted && sessionID !== undefined) sink.removeSession?.(sessionID);
      else if (sessionID !== undefined && sink.stopSession) sink.stopSession(sessionID);
      else sink.stop();
    },
  });
  const control = controlOptions && createRepeatControl({ ...controlOptions,
    view: coordinator.view,
    refresh: coordinator.refresh,
    status: () => sink.status?.(), isPaused: pause.isPaused, isEnabled: pause.isEnabled,
    latest: () => {
      const target = coordinator.latest();
      return target && { sessionID: target.selection.sessionID, messageID: target.selection.messageID, busy: target.busy };
    },
    speak: async (sessionID, messageID) => {
      const target = coordinator.latest();
      if (target && !target.busy && target.selection.sessionID === sessionID && target.selection.messageID === messageID)
        await coordinator.deliver(target.selection);
    },
    getPlaybackSpeed: pause.getPlaybackSpeed,
    control: (action) => {
      const speed = speedOfAction(action);
      if (speed !== undefined) pause.setPlaybackSpeed(speed);
      else if (action === "resume" && pause.isPaused()) {
        const retained = coordinator.takePending();
        // Discard frozen ownership before the resume edge: even a pending pause ack cannot thaw it.
        if (retained) {
          try { sink.stop(); } catch { return; }
        }
        pause.setPaused(false);
        if (retained && pause.isEnabled()) {
          try { void coordinator.deliver(retained).catch(() => {}); } catch {}
        }
      }
      else if (action === "pause") { coordinator.resetDiscovery(); pause.setPaused(true); }
      else if (action === "resume") pause.setPaused(false);
      else if (action === "disable") {
        if (pause.isEnabled()) coordinator.clearPending();
        pause.setEnabled(false);
      }
      else if (action === "enable") pause.setEnabled(true);
    },
    repeat: async (sessionID, revision, expires) => { await sink.repeat?.(sessionID, revision, expires); } });
  let disposed = false;
  const event: NonNullable<Hooks["event"]> = async (input) => {
    if (disposed) return;
    if (input.event.type === "tui.command.execute" && await control?.handle(input.event.properties.command)) return;
    await coordinator.event(input);
  };
  return { event, dispose: async () => {
    if (disposed) return;
    disposed = true; control?.dispose(); coordinator.dispose();
    try { sink.stop(); } finally { await sink.dispose?.(); }
  } };
}

/** Admission guard below coordinator retention; lifecycle methods retain their original forwarding. */
export function withPause(sink: SpeechSink, isPaused: () => boolean, isEnabled: () => boolean = () => true): SpeechSink {
  const wrapped = (async (selection: Selection) => {
    if (isPaused() || !isEnabled()) return;
    await sink(selection);
  }) as SpeechSink;
  wrapped.stop = () => sink.stop();
  if (sink.pause) wrapped.pause = () => sink.pause!();
  if (sink.resume) wrapped.resume = () => sink.resume!();
  wrapped.status = () => isEnabled() ? sink.status?.() : undefined;
  wrapped.repeat = async (sessionID, revision, expires) => { if (!isPaused() && isEnabled()) await sink.repeat?.(sessionID, revision, expires); };
  if (sink.stopSession) wrapped.stopSession = (sessionID) => sink.stopSession!(sessionID);
  wrapped.removeSession = (sessionID) => sink.removeSession?.(sessionID);
  wrapped.dispose = async () => { await sink.dispose?.(); };
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

/** Re-chooses the engine on every utterance so `open-vox engine ...` applies without a restart. */
export function liveEngine(
  wanted: () => string,
  factories: Factories,
  fallback: Engine = sapiEngine(),
  onChoice?: (name: string) => void,
  onDiagnostic?: (code: string) => void,
): Engine {
  let last = "";
  const reduced = new Set<Engine>();
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
  const notify = (selected: Engine) => {
    if (!reduced.has(selected)) { reduced.add(selected); onDiagnostic?.("reduced-pronunciation:text-only-engine"); }
  };
  engine.synthesizePlan = (plan, wav) => {
    const selected = select();
    if (selected.synthesizePlan) return selected.synthesizePlan(plan, wav);
    notify(selected);
    if (!selected.synthesize) throw new Error("Selected engine cannot generate audio");
    return selected.synthesize(flattenNarrationPlan(plan), plan.defaultLanguage, wav);
  };
  engine.speakPlan = plan => {
    const selected = select();
    if (selected.speakPlan) return selected.speakPlan(plan);
    notify(selected);
    return selected(flattenNarrationPlan(plan), plan.defaultLanguage);
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
  audio?: { cache: AudioStore; isPaused: () => boolean } & Pick<SpeechSinkOptions, "player" | "playbackTimeoutMs" | "isEnabled">,
): SpeechSink {
  const diagnostic = (code: string) => log(`narration diagnostic: ${code}`);
  const factories: Factories = {
    kokoro: memo(() => defaultKokoroEngine(env, config, diagnostic)),
    piper: memo(() => defaultPiperEngine(env)),
  };
  const wanted = () => (envValue(env, "ENGINE") ?? config().engine).toLowerCase();
  return createSpeechSink({
    enabled,
    ...audio,
    narrationLanguage: () => config().narrationLanguage,
    engine: liveEngine(wanted, factories, sapiEngine(), (name) => log(`engine=${name}`), diagnostic),
    onDiagnostic: diagnostic,
    onError: (error) => log(`speech error: ${error instanceof Error ? error.message : String(error)}`),
  });
}

/** Speaks one text with the current settings and waits for it to finish (used by `open-vox say`). */
export async function speakOnce(text: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const errors: string[] = [];
  const sink = createLiveSink(env, createConfigReader(() => readConfig(), 0), (m) => {
    if (m.startsWith("speech error")) errors.push(m);
    else if (m.startsWith("narration diagnostic")) console.warn(m);
  });
  await sink({ sessionID: "cli", messageID: "cli", text });
  if (errors.length > 0) throw new Error(errors.join("; "));
}

/** The player watches each playback by its own duration; this is only a last-resort ceiling for the sink. */
const PLAYBACK_BACKSTOP_MS = 30 * 60_000;

export const OpenVoxPlugin: Plugin = async ({ client, directory }) => {
  const log = debugLog(envValue(process.env, "LOG"));
  let enabled = envValue(process.env, "DISABLED") !== "1" && process.platform === "win32";
  const config = createConfigReader();
  let cache: AudioCache | undefined;
  if (enabled) {
    try { cache = new AudioCache(); }
    catch { enabled = false; log("audio cache unavailable; narration disabled"); }
  }
  // Capability is settled before state creation. Off flags precede owned cancellation/cache invalidation.
  // Rates affect only the persistent player's retained WAV, never PN preparation or synthesis settings.
  const pause = createPauseState(() => pauseSink(sink), () => sink.resume?.(),
    { capable: enabled, onDisable: () => disableService(sink, cache),
      onPlaybackSpeed: speed => { void player?.setRate(speed).catch(() => {}); } });
  const isPaused = pause.isPaused;
  // One persistent player host per plugin instance; it starts lazily on the first cached playback.
  const player = cache ? createPlayer({ log: (message) => log(message) }) : undefined;
  const sink = createLiveSink(process.env, config, log, enabled, cache && player
    ? { cache, isPaused, isEnabled: pause.isEnabled, player: (wav) => player.play(wav), playbackTimeoutMs: PLAYBACK_BACKSTOP_MS }
    : undefined);
  log(`plugin ready enabled=${enabled}`);
  const logged = (async (selection: Selection) => {
    log(`selection session=${selection.sessionID} message=${selection.messageID} chars=${selection.text.length} paused=${isPaused()}`);
    await sink(selection);
  }) as SpeechSink;
  logged.stop = () => sink.stop();
  logged.pause = sink.pause;
  logged.resume = sink.resume;
  logged.repeat = sink.repeat;
  logged.status = sink.status;
  logged.stopSession = sink.stopSession;
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
      messages: async (input) => {
        const result = await client.session.messages(input);
        log(`session.messages ${result.error ? "error" : "ok"}`);
        return result as Result<MessageData[]>;
      },
    },
  } : (client as unknown as Client);
  const hooks = createOpenVox(traced, directory, withPause(logged, isPaused, pause.isEnabled), pause, {
    instance: cache?.instance,
    publish: async (command) => {
      const result = await client.tui.publish({ query: { directory },
        body: { type: "tui.command.execute", properties: { command } }, signal: AbortSignal.timeout(2000) });
      if (result.error || !result.data) throw new Error("Repeat status transport failed");
    },
  });
  return { ...hooks, dispose: async () => {
    try { await hooks.dispose?.(); } finally { await player?.dispose(); }
  } };
};
