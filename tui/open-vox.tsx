// @ts-nocheck
/** @jsxImportSource @opentui/solid */
// OpenCode TUI plugin: confirmed instance controls in the sidebar.
// `open-vox install` copies this file into the OpenCode config directory and rewrites
// the "../src/config" import below to an absolute URL, so it resolves solid and opentui
// from OpenCode's own dependencies (a second copy would break reactivity).
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { For, createMemo, createSignal, onCleanup } from "solid-js"
import { KOKORO_VOICES, readConfig, writeConfig } from "../src/config"
import { createRepeatUi, buttonHandlers, canPause, canSetSpeed, publishAttached, sameView, serviceIcon, speedLabel } from "../src/repeat-ui"

const id = "open-vox"

const label = (voiceId: string) => KOKORO_VOICES.find((v) => v.id === voiceId)?.label ?? voiceId

function Block(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [config, setConfig] = createSignal(readConfig())
  // The CLI and other sessions can change the shared voice settings, so keep the block in sync.
  // Pause is not a shared setting: it is per plugin instance and shown from the confirmed status reply.
  const timer = setInterval(() => setConfig(readConfig()), 1000)
  onCleanup(() => clearInterval(timer))

  const session = () => {
    const route = props.api.route.current
    return route.name === "session" && route.params?.sessionID === props.sessionID ? props.sessionID : ""
  }
  // Pause, service and playback preference remain neutral until confirmed by this instance.
  const [view, setView] = createSignal({ paused: undefined, enabled: undefined, canControl: false, canRepeat: false, playbackSpeed: undefined }, { equals: sameView })
  const repeat = createRepeatUi({
    subscribe: (receive) => props.api.event.on("tui.command.execute", (event) => receive(event.properties.command)),
    publish: (command) => publishAttached(props.api.client, props.api.state.path.directory, command),
    onChange: () => setView(repeat.view(session())),
  })
  const paused = () => view().paused === true
  const icon = () => serviceIcon(view())
  const iconColor = () => ({ on: theme().success, off: theme().error, unknown: theme().textMuted })[icon().tone]
  const toggleService = buttonHandlers(
    () => { void repeat.toggleEnabled(session()) },
    () => !icon().clickable || !serviceIcon(repeat.view(session())).clickable,
  )
  const repeatTimer = setInterval(() => {
    repeat.refresh(session())
    setView(repeat.view(session()))
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
      minWidth={6}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      paddingLeft={0}
      paddingRight={0}
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
      <box flexDirection="row" gap={1}>
        <box flexShrink={0} width={1} onMouseDown={toggleService.onMouseDown}>
          <text fg={iconColor()}>{icon().tone === "unknown" ? "\u25CB" : "\u25CF"}</text>
        </box>
        <text fg={theme().text} flexGrow={1} wrapMode="word">
          <b>Open-Vox</b>
          <span style={{ fg: theme().textMuted }}>{` ES ${label(config().voices.es)} / EN ${label(config().voices.en)}`}</span>
          <span style={{ fg: view().enabled === false ? theme().error : paused() ? theme().warning : theme().textMuted }}>
            {view().enabled === false ? " off" : paused() ? " paused" : ""}
          </span>
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        {button(() => (paused() ? "Resume" : "Pause"), () => { void repeat.togglePause(session()) }, paused, false,
          () => !canPause(view()) || !canPause(repeat.view(session())))}
        {button(() => "Voice", chooseVoice, undefined, true)}
        {button(() => "Repeat", () => { void repeat.repeat(session()) }, undefined, false,
          () => !view().canRepeat || !repeat.available(session()))}
        {/* The rate button shares the row: four equal slots. It displays only confirmed
            preference, highlights non-1x and stays usable while paused. */}
        {button(() => speedLabel(view().playbackSpeed), () => { void repeat.cycleSpeed(session()) },
          () => view().playbackSpeed !== undefined && view().playbackSpeed !== 1, false,
          () => !canSetSpeed(view()) || !canSetSpeed(repeat.view(session())))}
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

