import { randomUUID } from "node:crypto";

export const REPEAT_PREFIX = "open-vox.repeat.v1:";
export const CONTROL_TTL = 2000;
export type AudioStatus = { sessionID: string; revision: number };
/** Runtime actions a TUI may request. New actions are added here and nowhere else in the wire format. */
export const CONTROL_ACTIONS = ["pause", "resume", "disable", "enable"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type ControlMessage = {
  kind: "hello" | "status" | "repeat" | "control";
  sessionID: string;
  expires: number;
  challenge?: string;
  instance?: string;
  revision?: number;
  paused?: boolean;
  /** Confirmed instance state; absent in older status messages means enabled. */
  enabled?: boolean;
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
    if (m.kind === "hello" && id(m.challenge)) return m;
    if (!id(m.instance)) return;
    // Control requests carry no audio revision: they act on the instance, not on retained audio.
    if (m.kind === "control" && id(m.requestID) && action(m.action)) return m;
    if (!Number.isSafeInteger(m.revision) || m.revision < 0) return;
    if (m.kind === "status" && id(m.challenge) && typeof m.paused === "boolean") {
      if (m.enabled !== undefined && typeof m.enabled !== "boolean") return;
      return { ...m, enabled: m.enabled ?? true };
    }
    if (m.kind === "repeat" && id(m.requestID)) return m;
  } catch {}
}

/** The caller publishes only through its attached SDK client, never through global discovery. */
export function createRepeatControl(options: {
  instance?: string;
  now?: () => number;
  status: () => AudioStatus | undefined;
  isPaused: () => boolean;
  isEnabled?: () => boolean;
  /** Applies a validated control action to the instance state; failures stay inside the host hook. */
  control?: (action: ControlAction) => void | Promise<void>;
  repeat: (sessionID: string, revision: number, expires: number) => Promise<void>;
  publish: (command: string) => Promise<void>;
}) {
  const instance = options.instance ?? randomUUID(), now = options.now ?? Date.now;
  const consumed = new Map<string, number>();
  let disposed = false, publishing = false;
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
          if (publishing) return true;
          publishing = true;
          const status = options.status();
          try {
            await options.publish(encodeCommand({ kind: "status", challenge: m.challenge, instance,
              sessionID: m.sessionID, revision: status?.sessionID === m.sessionID ? status.revision : 0,
              paused: options.isPaused(), enabled: options.isEnabled?.() ?? true, expires: m.expires }));
          } finally { publishing = false; }
        } else if (m.kind === "repeat" && m.instance === instance) {
          if (!consume(m.requestID!, m.expires, time)) return true; // Paused/stale requests are consumed, never deferred.
          const status = options.status();
          if (!options.isPaused() && (options.isEnabled?.() ?? true) && status?.sessionID === m.sessionID && status.revision === m.revision)
            await options.repeat(m.sessionID, m.revision!, m.expires);
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
