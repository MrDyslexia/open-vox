import { randomUUID } from "node:crypto";
import { CONTROL_TTL, decodeCommand, encodeCommand, nextPlaybackSpeed, speedAction,
  type ControlAction, type ControlMessage, type PlaybackSpeed, type ModelDevice } from "./repeat-control";

/** Confirmed instance state only; undefined is neutral, never an optimistic On/Off. */
export type SidebarView = { paused: boolean | undefined; enabled: boolean | undefined; canControl: boolean; canRepeat: boolean; canSpeak?: boolean; playbackSpeed: PlaybackSpeed | undefined; lidDevice?: ModelDevice; kokoroDevice?: ModelDevice };
export const sameView = (a: SidebarView, b: SidebarView) =>
  a.paused === b.paused && a.enabled === b.enabled && a.canControl === b.canControl && a.canRepeat === b.canRepeat &&
  a.playbackSpeed === b.playbackSpeed && a.canSpeak === b.canSpeak &&
  a.lidDevice === b.lidDevice && a.kokoroDevice === b.kokoroDevice;

export const deviceLabel = (view: Pick<SidebarView, "lidDevice" | "kokoroDevice">) => {
  const label = (device: ModelDevice | undefined) => device === "cpu" ? "CPU" : device === "gpu" ? "GPU" : "Pending";
  return `LID: ${label(view.lidDevice)} · Kokoro: ${label(view.kokoroDevice)}`;
};

export const canPause = (view: SidebarView) => view.canControl && view.enabled === true;
/** Rate cycling also requires a confirmed value; paused playback still accepts it. */
export const canSetSpeed = (view: SidebarView) => canPause(view) && view.playbackSpeed !== undefined;
/** Confirmed stored preference, not audible host acknowledgment; neutral until discovered. */
export const speedLabel = (speed: PlaybackSpeed | undefined) => speed === undefined ? "Speed" : `${speed.toFixed(1)}x`;
export const serviceIcon = (view: SidebarView): { tone: "on" | "off" | "unknown"; clickable: boolean } => ({
  tone: view.enabled === undefined ? "unknown" : view.enabled ? "on" : "off",
  clickable: view.enabled !== undefined && view.canControl,
});

type UiClient = { tui: { publish(parameters: {
  directory: string;
  body: { type: "tui.command.execute"; properties: { command: string } };
}, options: { signal: AbortSignal }): Promise<{ data?: boolean; error?: unknown }> } };

/** v2 SDK preserves the event under body; flattened type/properties are not a publish payload. */
export async function publishAttached(client: UiClient, directory: string, command: string): Promise<void> {
  const result = await client.tui.publish({ directory, body: { type: "tui.command.execute", properties: { command } } },
    { signal: AbortSignal.timeout(CONTROL_TTL) });
  if (result.error || !result.data) throw new Error("Control transport failed");
}

export function buttonHandlers(action: () => void, disabled: () => boolean = () => false, onRelease = false) {
  const guarded = () => { if (!disabled()) action(); };
  return { onMouseDown: onRelease ? undefined : guarded, onMouseUp: onRelease ? guarded : undefined };
}

/** Subscribe first; settle correlated replies before accepting a single unambiguous instance. */
export function createRepeatUi(options: {
  subscribe: (receive: (command: string) => void) => () => void;
  publish: (command: string) => Promise<void>;
  onChange: () => void;
  now?: () => number;
  id?: () => string;
}) {
  const now = options.now ?? Date.now, id = options.id ?? randomUUID;
  let pending: { challenge: string; sessionID: string; expires: number; settle: number; reply?: ControlMessage } | undefined;
  let status: ControlMessage | undefined;
  let conflict = false, disposed = false, sending = false, discovering = false;
  async function send(command: string): Promise<void> {
    if (disposed || sending) return;
    sending = true;
    try { await options.publish(command); }
    finally { sending = false; if (!disposed) options.onChange(); }
  }
  const off = options.subscribe((command) => {
    const m = decodeCommand(command);
    if (disposed || m?.kind !== "status") return;
    if (!pending || m.challenge !== pending.challenge || m.sessionID !== pending.sessionID ||
        m.expires !== pending.expires || m.expires <= now()) return;
    if ((pending.reply && pending.reply.instance !== m.instance) ||
        (status && status.expires > now() && status.instance !== m.instance))
      conflict = true;
    pending.reply = m;
    if (conflict) status = undefined;
    // The accepted instance reports its latest pause/audio state right away (restrictions must not wait
    // for settlement); the lease keeps its original expiry, so only a settled reply can extend it.
    else if (status && status.expires > now() && status.instance === m.instance)
      status = { ...status, paused: m.paused, enabled: m.enabled, playbackSpeed: m.playbackSpeed,
        revision: m.revision, messageID: m.messageID, busy: m.busy,
        lidDevice: m.lidDevice, kokoroDevice: m.kokoroDevice };
    options.onChange();
  });
  /** The confirmed status for this session, or undefined when nothing validated and unexpired exists. */
  const confirmed = (sessionID: string) => {
    // Renewal candidates earn their own settlement; the accepted lease keeps its original expiry.
    if (!disposed && !discovering && !conflict && pending?.reply && now() >= pending.settle && pending.expires > now())
      status = pending.reply;
    return !disposed && !conflict && !!status && status.sessionID === sessionID && status.expires > now()
      ? status : undefined;
  };
  const view = (sessionID: string): SidebarView => {
    const current = confirmed(sessionID);
    return {
      paused: current ? current.paused === true : undefined,
      enabled: current ? current.enabled !== false : undefined,
      playbackSpeed: current ? current.playbackSpeed ?? 1 : undefined,
      ...(current?.enabled !== false && current?.lidDevice ? { lidDevice: current.lidDevice } : {}),
      ...(current?.enabled !== false && current?.kokoroDevice ? { kokoroDevice: current.kokoroDevice } : {}),
      canControl: !!current && !sending,
      canRepeat: !!current && !sending && current.enabled !== false && !current.paused && current.revision! > 0,
      canSpeak: !!current && !sending && current.enabled !== false && !current.paused && !current.busy &&
        !!current.messageID && current.revision === 0,
    };
  };
  const available = (sessionID: string) => view(sessionID).canRepeat;
  const refresh = (sessionID: string) => {
    if (disposed) return;
    // Route/session invalidation must not wait for an outstanding transport operation.
    if (!sessionID || (pending && pending.sessionID !== sessionID)) {
      pending = undefined; status = undefined; conflict = false; options.onChange();
    }
    if (!sessionID || discovering || sending) return;
    if (pending?.sessionID === sessionID && pending.expires > now() + 400) return;
    pending = { challenge: id(), sessionID, expires: now() + CONTROL_TTL, settle: now() + 250 };
    conflict = false;
    const challenge = pending.challenge;
    const command = encodeCommand({ kind: "hello", challenge, sessionID, expires: pending.expires });
    discovering = true;
    void (async () => {
      try { await options.publish(command); }
      catch {
        if (pending?.challenge === challenge) { status = undefined; conflict = true; }
      } finally { discovering = false; if (!disposed) options.onChange(); }
    })();
    options.onChange();
  };
  /** Publishes one control action to the confirmed instance, never optimistic and never concurrent. */
  async function control(sessionID: string, action: ControlAction): Promise<void> {
    const target = confirmed(sessionID);
    if (!target || sending) return;
    try {
      await send(encodeCommand({ kind: "control", instance: target.instance, sessionID, action,
        requestID: id(), expires: now() + CONTROL_TTL }));
    } catch { status = undefined; conflict = true; if (!disposed) options.onChange(); return; }
    // Drop the in-flight challenge so the existing refresh path asks for a fresh status right away;
    // a late reply to the old challenge can no longer be accepted.
    pending = undefined;
    refresh(sessionID);
  }
  return {
    available,
    view,
    refresh,
    control,
    /** Sends the explicit opposite of the CONFIRMED pause state; with no confirmation it does nothing. */
    async togglePause(sessionID: string): Promise<void> {
      const { paused, enabled } = view(sessionID);
      if (paused === undefined || enabled !== true) return;
      await control(sessionID, paused ? "resume" : "pause");
    },
    /** Request the opposite confirmed service state, including On while Off; never optimistic. */
    async toggleEnabled(sessionID: string): Promise<void> {
      const enabled = view(sessionID).enabled;
      if (enabled === undefined) return;
      await control(sessionID, enabled ? "disable" : "enable");
    },
    /** Publish the next explicit target from confirmed state; an unconfirmed click never advances it. */
    async cycleSpeed(sessionID: string): Promise<void> {
      const current = view(sessionID);
      if (!canSetSpeed(current)) return;
      await control(sessionID, speedAction(nextPlaybackSpeed(current.playbackSpeed)));
    },
    async repeat(sessionID: string): Promise<void> {
      if (!available(sessionID)) return;
      try {
        await send(encodeCommand({ kind: "repeat", instance: status!.instance, sessionID,
          messageID: status!.messageID, revision: status!.revision, requestID: id(), expires: now() + CONTROL_TTL }));
      } catch { status = undefined; conflict = true; if (!disposed) options.onChange(); }
    },
    async speak(sessionID: string): Promise<void> {
      const target = confirmed(sessionID);
      if (!target || !view(sessionID).canSpeak) return;
      try {
        await send(encodeCommand({ kind: "speak", instance: target.instance, sessionID,
          messageID: target.messageID, revision: 0, requestID: id(), expires: now() + CONTROL_TTL }));
      } catch { status = undefined; conflict = true; if (!disposed) options.onChange(); return; }
      pending = undefined;
      refresh(sessionID);
    },
    dispose() { disposed = true; pending = undefined; status = undefined; off(); },
  };
}
