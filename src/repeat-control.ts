import { randomUUID } from "node:crypto";

export const REPEAT_PREFIX = "open-vox.repeat.v1:";
export const CONTROL_TTL = 2000;
export type AudioStatus = { sessionID: string; revision: number };
export type ControlMessage = {
  kind: "hello" | "status" | "repeat";
  sessionID: string;
  expires: number;
  challenge?: string;
  instance?: string;
  revision?: number;
  paused?: boolean;
  requestID?: string;
};
const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
export const encodeCommand = (message: ControlMessage): string => REPEAT_PREFIX + JSON.stringify(message);

export function decodeCommand(command: unknown): ControlMessage | undefined {
  if (typeof command !== "string" || !command.startsWith(REPEAT_PREFIX) || command.length > 2048) return;
  try {
    const m = JSON.parse(command.slice(REPEAT_PREFIX.length));
    if (!m || !id(m.sessionID) || !Number.isSafeInteger(m.expires)) return;
    if (m.kind === "hello" && id(m.challenge)) return m;
    if (!id(m.instance) || !Number.isSafeInteger(m.revision) || m.revision < 0) return;
    if (m.kind === "status" && id(m.challenge) && typeof m.paused === "boolean") return m;
    if (m.kind === "repeat" && id(m.requestID)) return m;
  } catch {}
}

/** The caller publishes only through its attached SDK client, never through global discovery. */
export function createRepeatControl(options: {
  instance?: string;
  now?: () => number;
  status: () => AudioStatus | undefined;
  isPaused: () => boolean;
  repeat: (sessionID: string, revision: number, expires: number) => Promise<void>;
  publish: (command: string) => Promise<void>;
}) {
  const instance = options.instance ?? randomUUID(), now = options.now ?? Date.now;
  const consumed = new Map<string, number>();
  let disposed = false, publishing = false;
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
              paused: options.isPaused(), expires: m.expires }));
          } finally { publishing = false; }
        } else if (m.kind === "repeat" && m.instance === instance) {
          for (const [key, expiry] of consumed) if (expiry <= time) consumed.delete(key);
          if (consumed.has(m.requestID!) || consumed.size >= 64) return true;
          consumed.set(m.requestID!, m.expires); // Paused/stale requests are consumed, never deferred.
          const status = options.status();
          if (!options.isPaused() && status?.sessionID === m.sessionID && status.revision === m.revision)
            await options.repeat(m.sessionID, m.revision!, m.expires);
        }
      } catch { /* Transport, pause-reader and playback failures stay inside the host hook. */ }
      return true;
    },
    dispose() { disposed = true; consumed.clear(); },
  };
}
