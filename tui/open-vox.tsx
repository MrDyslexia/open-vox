// @ts-nocheck
/** @jsxImportSource @opentui/solid */
// OpenCode TUI plugin: a small open-vox block in the sidebar with two buttons.
// `open-vox install` copies this file into the OpenCode config directory and rewrites
// the "../src/config" import below to an absolute URL, so it resolves solid and opentui
// from OpenCode's own dependencies (a second copy would break reactivity).
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { For, createMemo, createSignal, onCleanup } from "solid-js"
import { KOKORO_VOICES, readConfig, writeConfig } from "../src/config"
import { createRepeatUi, buttonHandlers, publishAttached } from "../src/repeat-ui"

const id = "open-vox"

const label = (voiceId: string) => KOKORO_VOICES.find((v) => v.id === voiceId)?.label ?? voiceId

function Block(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [config, setConfig] = createSignal(readConfig())
  // The CLI and other sessions can change the shared settings, so keep the block in sync.
  const timer = setInterval(() => setConfig(readConfig()), 1000)
  onCleanup(() => clearInterval(timer))

  const paused = () => config().paused
  const toggle = () => setConfig(writeConfig({ paused: !paused() }))
  const [canRepeat, setCanRepeat] = createSignal(false)
  const session = () => {
    const route = props.api.route.current
    return route.name === "session" && route.params?.sessionID === props.sessionID ? props.sessionID : ""
  }
  const repeat = createRepeatUi({
    subscribe: (receive) => props.api.event.on("tui.command.execute", (event) => receive(event.properties.command)),
    publish: (command) => publishAttached(props.api.client, props.api.state.path.directory, command),
    onChange: () => setCanRepeat(repeat.available(session(), paused())),
  })
  const repeatTimer = setInterval(() => {
    repeat.refresh(session())
    setCanRepeat(repeat.available(session(), paused()))
  }, 250)
  onCleanup(() => { clearInterval(repeatTimer); repeat.dispose() })

  const chooseVoice = () => {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title="open-vox voice"
        options={KOKORO_VOICES.map((v) => ({
          title: `${v.label}`,
          value: v.id,
          description: `${v.gender}, ${v.accent}`,
          category: v.language === "es" ? "Spanish" : "English",
        }))}
        onSelect={(option) => {
          const voice = KOKORO_VOICES.find((v) => v.id === option.value)
          if (!voice) return
          setConfig(writeConfig({ voices: { [voice.language]: voice.id } }))
          props.api.ui.dialog.clear()
          props.api.ui.toast({
            variant: "success",
            message: `${voice.language === "es" ? "Spanish" : "English"} voice: ${voice.label}`,
          })
        }}
      />
    ))
  }

  // `onRelease` buttons act on mouse-up. A button that opens a dialog must do this: the host
  // dialog backdrop dismisses itself on mouse-up, so opening on mouse-down makes the
  // dialog appear under the pointer and be closed by the very same click.
  const button = (text: () => string, onClick: () => void, active?: () => boolean, onRelease = false, disabled = () => false) => (
    <box
      flexGrow={1}
      flexBasis={0}
      minWidth={8}
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={active?.() ? theme().warning : theme().backgroundElement}
      onMouseDown={buttonHandlers(onClick, disabled, onRelease).onMouseDown}
      onMouseUp={buttonHandlers(onClick, disabled, onRelease).onMouseUp}
    >
      <text fg={disabled() ? theme().textMuted : active?.() ? theme().background : theme().text}><b>{text()}</b></text>
    </box>
  )

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme().text} width="100%" wrapMode="word">
        <b>Open-Vox</b>
        <span style={{ fg: theme().textMuted }}>{` ES ${label(config().voices.es)} / EN ${label(config().voices.en)}`}</span>
        <span style={{ fg: paused() ? theme().warning : theme().textMuted }}>{paused() ? " paused" : ""}</span>
      </text>
      <box flexDirection="row" gap={1}>
        {button(() => (paused() ? "Resume" : "Pause"), toggle, paused)}
        {button(() => "Voice", chooseVoice, undefined, true)}
        {button(() => "Repeat", () => { void repeat.repeat(session(), paused()) }, undefined, false,
          () => !canRepeat() || !repeat.available(session(), paused()))}
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_context, props) {
        return <Block api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin = { id, tui }

export default plugin

