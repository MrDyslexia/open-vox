// OpenCode V2 replaces the V1 `tui.command.execute` bus with plugin RPC. The encoded
// command strings are unchanged: the TUI calls `command`, the server answers through the
// `command` event. Kept dependency-free so the TUI plugin can import it cheaply.
const commandSchema = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
  additionalProperties: false,
} as const;

export const OPEN_VOX_RPC = {
  id: "open-vox",
  methods: {
    command: { input: commandSchema, output: { type: "object" } },
  },
  events: {
    command: { schema: commandSchema },
  },
} as const;
