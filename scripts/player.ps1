# Persistent audio host for Open-Vox (WPF MediaPlayer on a single STA thread).
#
# Start: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File player.ps1
# stdin  (one command per line): play <path> | pause | resume | rate <x> | stop | status | quit
# stdout (one JSON object per line): ready opened playing paused rate position ended stopped error bye
# Env OV_PLAYER_MUTE=1 plays at volume 0 (tests and smoke runs).
#
# Rules this script depends on (verified in a spike):
#  - The Dispatcher must be pumped on this thread or MediaOpened/MediaEnded never fire, so stdin is
#    polled with ReadLineAsync inside the pump loop and never read with a blocking call.
#  - Close() releases the file handle; it runs BEFORE ended/stopped is reported so the caller can
#    delete the WAV right away. Close() also resets SpeedRatio to 1.0, so the rate is reapplied.
#  - Open() of the same URI without a Close() raises no MediaOpened, so every play closes first.
$ErrorActionPreference = 'Stop'
$mute = ($env:OV_PLAYER_MUTE -eq '1')
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)

function Emit($h) { $out.WriteLine(($h | ConvertTo-Json -Compress)) }

$disp = [System.Windows.Threading.Dispatcher]::CurrentDispatcher
function DoEvents {
  $f = New-Object System.Windows.Threading.DispatcherFrame
  $null = $disp.BeginInvoke('Background', [System.Windows.Threading.DispatcherOperationCallback]{ param($o) $o.Continue = $false; $null }, $f)
  [System.Windows.Threading.Dispatcher]::PushFrame($f)
}

function DurationMs {
  if ($mp.NaturalDuration.HasTimeSpan) { [int]$mp.NaturalDuration.TimeSpan.TotalMilliseconds } else { -1 }
}

$st = @{ state = 'idle'; rate = 1.0; quit = $false }
$mp = New-Object System.Windows.Media.MediaPlayer
$mp.Volume = $(if ($mute) { 0.0 } else { 1.0 })

$mp.add_MediaOpened([EventHandler]{
  Emit @{ event = 'opened'; durationMs = (DurationMs) }
  $mp.SpeedRatio = $st.rate
  $mp.Play()
  $st.state = 'playing'
  Emit @{ event = 'playing' }
})
$mp.add_MediaEnded([EventHandler]{
  $st.state = 'idle'
  $mp.Close()
  Emit @{ event = 'ended' }
})
$mp.add_MediaFailed([EventHandler[System.Windows.Media.ExceptionEventArgs]]{
  param($s, $e)
  $st.state = 'idle'
  Emit @{ event = 'error'; message = $e.ErrorException.Message }
})

function Handle([string]$line) {
  $line = $line.Trim()
  if ($line -eq '') { return }
  $sp = $line.IndexOf(' ')
  $cmd = if ($sp -lt 0) { $line } else { $line.Substring(0, $sp) }
  $arg = if ($sp -lt 0) { '' } else { $line.Substring($sp + 1).Trim() }
  switch ($cmd) {
    'play' {
      $mp.Close()
      if (-not [System.IO.File]::Exists($arg)) { $st.state = 'idle'; Emit @{ event = 'error'; message = 'file not found' }; return }
      $st.state = 'opening'
      $mp.Open((New-Object Uri ([System.IO.Path]::GetFullPath($arg))))
    }
    'pause' {
      if ($st.state -eq 'playing') { $mp.Pause(); $st.state = 'paused' }
      Emit @{ event = 'paused'; positionMs = [int]$mp.Position.TotalMilliseconds }
    }
    'resume' {
      if ($st.state -eq 'paused') { $mp.Play(); $st.state = 'playing' }
      Emit @{ event = 'playing' }
    }
    'rate' {
      $x = [double]::Parse($arg, [Globalization.CultureInfo]::InvariantCulture)
      $st.rate = $x
      $mp.SpeedRatio = $x
      Emit @{ event = 'rate'; value = $mp.SpeedRatio }
    }
    'stop' {
      $mp.Stop()
      $mp.Close()
      $st.state = 'idle'
      Emit @{ event = 'stopped' }
    }
    'status' {
      Emit @{ event = 'position'; ms = [int]$mp.Position.TotalMilliseconds; durationMs = (DurationMs); state = $st.state; rate = $st.rate }
    }
    'quit' { $mp.Close(); $st.quit = $true }
    default { Emit @{ event = 'error'; message = "unknown command: $cmd" } }
  }
}

Emit @{ event = 'ready'; muted = $mute }

$task = $in.ReadLineAsync()
while (-not $st.quit) {
  DoEvents
  if ($task.IsCompleted) {
    $line = $task.Result
    if ($null -eq $line) { break }   # stdin closed: the parent is gone
    try { Handle $line } catch { Emit @{ event = 'error'; message = $_.Exception.Message } }
    $task = $in.ReadLineAsync()
  }
  Start-Sleep -Milliseconds 2
}
try { $mp.Close() } catch {}
Emit @{ event = 'bye'; reason = $(if ($st.quit) { 'quit' } else { 'stdin-closed' }) }
exit 0
