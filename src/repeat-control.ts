import { randomUUID } from "node:crypto";

export const REPEAT_PREFIX = "open-vox.repeat.v1:";
export const CONTROL_TTL = 2000;
export type AudioStatus = { sessionID: string; revision: number; messageID?: string };
/** Runtime actions a TUI may request. New actions are added here and nowhere else in the wire format. */
export const CONTROL_ACTIONS = ["pause", "resume", "disable", "enable", "speed:1", "speed:1.5", "speed:2"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Closed playback multipliers for retained WAV audio, unrelated to config synthesis speed. */
export const PLAYBACK_SPEEDS = [1, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];
export type SpeedAction = Extract<ControlAction, `speed:${string}`>;
export const isPlaybackSpeed = (v: unknown): v is PlaybackSpeed => typeof v === "number" && (PLAYBACK_SPEEDS as readonly number[]).includes(v);
export const speedAction = (speed: PlaybackSpeed): SpeedAction => `speed:${speed}`;
/** Explicit target rate, or undefined for service/pause actions. */
export const speedOfAction = (action: ControlAction): PlaybackSpeed | undefined => PLAYBACK_SPEEDS.find(speed => speedAction(speed) === action);
/** Invalid input counts as 1x; its next cycle step is 1.5x. */
export const nextPlaybackSpeed = (current: unknown): PlaybackSpeed => {
  const at = isPlaybackSpeed(current) ? PLAYBACK_SPEEDS.indexOf(current) : 0;
  return PLAYBACK_SPEEDS[(at + 1) % PLAYBACK_SPEEDS.length]!;
};

export type ControlMessage = {
  kind: "hello" | "status" | "repeat" | "speak" | "control";
  sessionID: string;
  expires: number;
  challenge?: string;
  instance?: string;
  revision?: number;
  messageID?: string;
  busy?: boolean;
  paused?: boolean;
  /** Confirmed instance state; absent in older status messages means enabled. */
  enabled?: boolean;
  /** An older status without this field decodes as 1x. */
  playbackSpeed?: PlaybackSpeed;
  requestID?: string;
  action?: ControlAction;
};
const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
const action = (v: unknown): v is ControlAction => typeof v === "string" && (CONTROL_ACTIONS as readonly string[]).includes(v);
export const encodeCommand = (message: ControlMessage): string => REPEAT_PREFIX + JSON.stringify(message);

export function decodeCommand(command: unknown): ControlMessage | undefined {
  if (typeof command !== "string" || !command.startsWith(REPEAT_PREFIX) || command.length > 2048) return;
  try {
    const m = JSON.parse(command.slice(REPEAT_PREFIX.length));
    if (!m || !id(m.sessionID) || !Number.isSafeInteger(m.expires)) return;
    if (m.messageID !== undefined && !id(m.messageID)) return;
    if (m.busy !== undefined && typeof m.busy !== "boolean") return;
    if (m.kind === "hello" && id(m.challenge)) return m;
    if (!id(m.instance)) return;
    // Control requests carry no audio revision: they act on the instance, not on retained audio.
    if (m.kind === "control" && id(m.requestID) && action(m.action)) return m;
    if (!Number.isSafeInteger(m.revision) || m.revision < 0) return;
    if (m.kind === "status" && id(m.challenge) && typeof m.paused === "boolean") {
      if (m.enabled !== undefined && typeof m.enabled !== "boolean") return;
      if (m.playbackSpeed !== undefined && !isPlaybackSpeed(m.playbackSpeed)) return;
      return { ...m, enabled: m.enabled ?? true, playbackSpeed: m.playbackSpeed ?? 1 };
    }
    if (m.kind === "repeat" && id(m.requestID)) return m;
    if (m.kind === "speak" && id(m.requestID) && id(m.messageID) && m.revision === 0) return m;
  } catch {}
}

/** The caller publishes only through its attached SDK client, never through global discovery. */
export function createRepeatControl(options: {
  instance?: string;
  now?: () => number;
  status: () => AudioStatus | undefined;
  latest?: () => { sessionID: string; messageID: string; busy: boolean } | undefined;
  view?: (sessionID: string) => void;
  refresh?: (sessionID: string, force?: boolean) => Promise<boolean>;
  speak?: (sessionID: string, messageID: string) => Promise<void>;
  isPaused: () => boolean;
  isEnabled?: () => boolean;
  /** Hosts without a runtime rate reader report the compatible 1x default. */
  getPlaybackSpeed?: () => PlaybackSpeed;
  /** Applies a validated control action to the instance state; failures stay inside the host hook. */
  control?: (action: ControlAction) => void | Promise<void>;
  repeat: (sessionID: string, revision: number, expires: number) => Promise<void>;
  publish: (command: string) => Promise<void>;
}) {
  const instance = options.instance ?? randomUUID(), now = options.now ?? Date.now;
  const consumed = new Map<string, number>();
  let disposed = false, publishing = false, selecting = false;
  /** One bounded history shared by every request kind: expired entries are purged, the cap is 64. */
  const consume = (requestID: string, expires: number, time: number): boolean => {
    for (const [key, expiry] of consumed) if (expiry <= time) consumed.delete(key);
    if (consumed.has(requestID) || consumed.size >= 64) return false;
    consumed.set(requestID, expires);
    return true;
  };
  return {
    instance,
    async handle(command: unknown): Promise<boolean> {
      if (typeof command !== "string" || !command.startsWith(REPEAT_PREFIX)) return false;
      const m = decodeCommand(command), time = now();
      if (disposed || !m || m.expires <= time || m.expires > time + CONTROL_TTL) return true;
      try {
        if (m.kind === "hello") {
          options.view?.(m.sessionID);
          if (publishing) return true;
          publishing = true;
          try {
            await options.refresh?.(m.sessionID);
            if (disposed || m.expires <= now()) return true;
            const status = options.status();
            const latest = options.latest?.();
            const target = latest?.sessionID === m.sessionID ? latest : undefined;
            const matches = status?.sessionID === m.sessionID && (!options.latest ||
              (!!target && target.messageID === status.messageID));
            const speed: unknown = options.getPlaybackSpeed?.();
            await options.publish(encodeCommand({ kind: "status", challenge: m.challenge, instance,
              sessionID: m.sessionID, revision: matches ? status!.revision : 0,
              messageID: target?.messageID, busy: target?.busy,
              paused: options.isPaused(), enabled: options.isEnabled?.() ?? true,
              // An invalid host reader must never publish an undecodable rate.
              playbackSpeed: isPlaybackSpeed(speed) ? speed : 1, expires: m.expires }));
          } finally { publishing = false; }
        } else if ((m.kind === "repeat" || m.kind === "speak") && m.instance === instance) {
          if (!consume(m.requestID!, m.expires, time)) return true; // Paused/stale requests are consumed, never deferred.
          if (selecting || options.isPaused() || !(options.isEnabled?.() ?? true)) return true;
          selecting = true;
          let ownsSelection = true;
          try {
            if (await options.refresh?.(m.sessionID, true) === false || disposed || m.expires <= now()) return true;
            const status = options.status();
            const latest = options.latest?.();
            if (options.isPaused() || !(options.isEnabled?.() ?? true)) return true;
            if (options.latest && (!latest || latest.sessionID !== m.sessionID ||
                latest.messageID !== m.messageID || (m.kind === "speak" && latest.busy))) return true;
            if (m.kind === "speak") {
              if (latest && !(status?.sessionID === m.sessionID && status.messageID === m.messageID))
                await options.speak?.(m.sessionID, m.messageID!);
            } else if (status?.sessionID === m.sessionID && status.revision === m.revision &&
                (!options.latest || status.messageID === m.messageID)) {
              // Repeat may restart playback already in progress; serialize selection, not playback.
              selecting = false; ownsSelection = false;
              await options.repeat(m.sessionID, m.revision!, m.expires);
            }
          } finally { if (ownsSelection) selecting = false; }
        } else if (m.kind === "control" && m.instance === instance) {
          // The request is consumed before it runs, so a failing handler is never retried by a replay.
          if (!consume(m.requestID!, m.expires, time)) return true;
          await options.control?.(m.action!);
        }
      } catch { /* Transport, control-handler and playback failures stay inside the host hook. */ }
      return true;
    },
    dispose() { disposed = true; consumed.clear(); },
  };
}
