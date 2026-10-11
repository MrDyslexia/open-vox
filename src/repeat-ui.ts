import { randomUUID } from "node:crypto";
import { CONTROL_TTL, decodeCommand, encodeCommand, type ControlMessage } from "./repeat-control";

type UiClient = { tui: { publish(parameters: {
  directory: string;
  body: { type: "tui.command.execute"; properties: { command: string } };
}, options: { signal: AbortSignal }): Promise<{ data?: boolean; error?: unknown }> } };

/** v2 SDK preserves the event under body; flattened type/properties are not a publish payload. */
export async function publishAttached(client: UiClient, directory: string, command: string): Promise<void> {
  const result = await client.tui.publish({ directory, body: { type: "tui.command.execute", properties: { command } } },
    { signal: AbortSignal.timeout(CONTROL_TTL) });
  if (result.error || !result.data) throw new Error("Repeat transport failed");
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
  let pending: { challenge: string; sessionID: string; expires: number; settle: number } | undefined;
  let status: ControlMessage | undefined;
  let conflict = false, disposed = false, sending = false;
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
    if (status && status.instance !== m.instance) conflict = true;
    status = m;
    options.onChange();
  });
  const available = (sessionID: string, paused: boolean) => !disposed && !sending && !paused && !conflict &&
    !!pending && pending.sessionID === sessionID && now() >= pending.settle &&
    !!status && status.sessionID === sessionID && !status.paused && status.revision! > 0 && status.expires > now();
  return {
    available,
    refresh(sessionID: string) {
      if (disposed || sending) return;
      if (!sessionID) {
        pending = undefined; status = undefined; options.onChange(); return;
      }
      if (pending?.sessionID === sessionID && pending.expires > now() + 400) return;
      pending = { challenge: id(), sessionID, expires: now() + CONTROL_TTL, settle: now() + 250 };
      status = undefined; conflict = false;
      const challenge = pending.challenge;
      void send(encodeCommand({ kind: "hello", challenge, sessionID, expires: pending.expires })).catch(() => {
        if (pending?.challenge === challenge) { status = undefined; conflict = true; options.onChange(); }
      });
      options.onChange();
    },
    async repeat(sessionID: string, paused: boolean): Promise<void> {
      if (!available(sessionID, paused)) return;
      try {
        await send(encodeCommand({ kind: "repeat", instance: status!.instance, sessionID,
          revision: status!.revision, requestID: id(), expires: now() + CONTROL_TTL }));
      } catch { status = undefined; conflict = true; if (!disposed) options.onChange(); }
    },
    dispose() { disposed = true; pending = undefined; status = undefined; off(); },
  };
}
