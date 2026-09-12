# Native `caffeinate` Plan (macOS primary, Electron fallback)

> Status: **plan, not yet implemented**. Decisions locked: tray is a config flag
> (default **off** on macOS, **on** elsewhere); default flags `-i -d`; keep the
> idle-timeout semantic. The OpenCode integration is tracked separately in
> `docs/opencode-compatibility.md` and is **not** part of this effort.

## Goal

On macOS, prevent sleep using the native `/usr/bin/caffeinate` binary instead of
Electron's `powerSaveBlocker`, so the default path needs **no Electron**. Keep Electron as a fallback for Linux/Windows and for the optional system-tray indicator.

## Core idea: decouple three concerns

Today they're coupled. Split them:

- **Trigger** — what signals "active" (Claude Code hooks; OpenCode later).
- **Decision** — when to release (idle-timeout logic, already in the polling server via `cleanupExpiredSessions` + `getActiveSessions`).
- **Mechanism** — how sleep is prevented. **This is what becomes swappable.**

The polling server stays the decision-maker. Only the mechanism changes.

## Decision matrix (backend + process)

One native inhibit tool per platform; Electron only when the tray is wanted.

| Platform | `tray` off (native) | `tray` on (Electron) |
|---|---|---|
| macOS | `caffeinate -i -d` | `powerSaveBlocker` + tray |
| Linux | `systemd-inhibit --what=sleep` | `powerSaveBlocker` + tray |
| Windows | `powercfg` / `SetThreadExecutionState` | `powerSaveBlocker` + tray |

Rationale: the only case where a native tool beats `powerSaveBlocker` is when we
drop the tray. If the tray is on, we're already in Electron, so `powerSaveBlocker`
is the natural mechanism. Each platform has a native "keep awake" primitive, so
the `tray: off` path can be dependency-free on every OS.

### Native tools per platform

- **macOS — `caffeinate`** (`/usr/bin/caffeinate`). Flags: `-i` idle, `-d`
   display, `-s` system (AC), `-u` user-active, `-t <secs>` timeout, `-w <pid>`
   wait-for-process. Default `-i -d`.
- **Linux — `systemd-inhibit`** (systemd only). `--what=sleep` blocks
   suspend/hibernate — the part that actually drops the connection and stops the
   work. `--what=idle` blocks idle. No display-sleep equivalent (that's the
   display server's job: X11 `xset dpms`, or a D-Bus call on Wayland). For
   "keep the machine awake during long turns," `--what=sleep` is precise and
   sufficient. Usage mirrors `caffeinate`:
    ```bash
    # hold until killed (server-owned lifetime, like the caffeinate child)
   systemd-inhibit --what=sleep --who=cc-caffeine --why="long turn" --mode=block
    ```
   `--mode=block` is strongest; `delay`/`weak` are softer. No command → holds
   until SIGTERM/SIGINT or stdin EOF. Caveats: requires systemd as init; some
   systems restrict inhibitors via `InhibitAllow=` in `logind.conf`.
- **Windows — `powercfg` / `SetThreadExecutionState`**. `powercfg /requests`
   inspects; the keep-awake primitive is the Win32 `SetThreadExecutionState`
   (`ES_SYSTEM_REQUIRED` + `ES_DISPLAY_REQUIRED`), which has no clean CLI — a
   tiny helper (a one-line `node -e` calling a native binding, or a small
   `powercfg`-based approach) would be needed. Lowest priority; Electron is the
   pragmatic default on Windows.

## File-by-file changes

### 1. `src/config.js` — two new settings

```js
const DEFAULTS = {
  session_timeout_minutes: 15,
  icon_theme: 'orange',
  tray: process.platform === 'darwin' ? false : true, // NEW
  caffeinate_flags: '-i -d'                            // NEW
}
```

- `tray` default is platform-dependent (off on macOS, on elsewhere).
- `caffeinate_flags` is the flag string passed to the native binary.
- Update the config table in `CLAUDE.md`/`README.md`.

### 2. `src/backend.js` — NEW: mechanism abstraction

A small module that hides native-vs-Electron behind `enable()`/`disable()`. The
native branch is a per-platform table; the Electron branch is the fallback.

```js
const { spawn } = require('child_process')
const { getConfig } = require('./config')

let child = null // native inhibit process

// Per-platform native "keep awake" command. Returns null when there is no
// native tool (or the tray is requested, forcing the Electron path).
const nativeCommand = () => {
  const cfg = getConfig()
  if (cfg.tray === true) return null // tray requested -> Electron
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'caffeinate', args: cfg.caffeinate_flags.split(/\s+/) }
    case 'linux':
      return {
        cmd: 'systemd-inhibit',
        args: ['--what=sleep', '--who=cc-caffeine', '--why=long turn', '--mode=block']
      }
    case 'win32':
      return null // no clean CLI; use Electron (see "Native tools per platform")
    default:
      return null
   }
}

const isNative = () => nativeCommand() !== null

const enable = () => {
  const native = nativeCommand()
  if (native) {
    if (child) return
    child = spawn(native.cmd, native.args, { stdio: 'ignore' })
    child.on('exit', () => { child = null })
   } else {
    const { powerSaveBlocker } = require('./electron').getElectron()
    powerSaveBlocker.start('prevent-app-suspension')
   }
}

const disable = () => {
  const native = nativeCommand()
  if (native) {
    if (child) { child.kill(); child = null }
   } else {
    const { powerSaveBlocker } = require('./electron').getElectron()
    powerSaveBlocker.stopAll()
   }
}

module.exports = { enable, disable, isNative, nativeCommand }
```

Notes:
- Native path: spawn the platform's inhibit tool (no `-t`/`-w` — the server owns
  its lifetime). Idempotent via the `child` guard.
- Electron path: `powerSaveBlocker.start/stopAll` (current behavior).
- `nativeCommand()` is the single switch: returns a command for a native-capable
  platform with `tray: false`, else `null` → Electron.
- **Phasing:** implement the `darwin` branch first (this fork's primary use case),
  then add `linux` (`systemd-inhibit`), then `win32` last.

### 3. `src/system-tray.js` — route through the backend

Replace the `powerSaveBlocker` calls in `enableCaffeine`/`disableCaffeine`
(`system-tray.js:129-149`) with `backend.enable()`/`backend.disable()`.

- Tray creation (`createSystemTray`) stays Electron-only and is **gated**: only
  create a tray when `getConfig().tray === true`. When `tray: false`, the server
  runs headless (no `Tray`, no `app.dock.hide()`).
- `updateCaffeineStatus` keeps calling `enableCaffeine`/`disableCaffeine`; only
  their internals change.

### 4. `src/server.js` — choose process + backend

- `startServerProcess` (`server.js:69-90`): pick the launcher by backend.
   - native → `spawn('node', ['caffeine.js', 'server'], { detached: true, stdio: 'ignore' })`
   - electron → current `spawn('npx', ['electron', 'caffeine.js', 'server'], ...)`
- `handleServer` (`server.js:95-135`): when native, run the polling loop with the
  native backend and **no Electron** (skip `preventWindowCreation`, `whenReady`,
  tray). When electron, keep the current flow.
- Wire the native child into shutdown: the existing SIGINT/SIGTERM handlers
  (`server.js:165-176`) should call `backend.disable()` so the `caffeinate`
  child is killed on server exit.

### 5. Orphan safety (decision point)

A spawned inhibit process that the server fails to clean up keeps the machine
awake forever. Two options:

- **A (simple):** kill the child in the SIGINT/SIGTERM handlers (above). Risk:
   `SIGKILL`/crash orphans the child.
- **B (robust):** tie the child to the server's lifetime so it auto-exits on
   server death. Per platform:
    - macOS: `caffeinate -w <serverPid> -i -d`
    - Linux: `systemd-inhibit` already releases on SIGTERM/SIGINT/stdin-EOF, so a
      clean SIGTERM on shutdown is enough; a `-w`-style guard isn't available.
    - To disable on idle, kill the child directly; to re-enable, spawn a new one.

Recommendation: start with **A** (kill on SIGINT/SIGTERM), add per-platform
auto-cleanup (B) if orphan risk matters.

### 6. Tests — `test/backend.test.js` (new)

Extend the existing `node --test` suite:
- `nativeCommand()` returns the right `{cmd,args}` per platform + `tray:false`,
   and `null` when `tray:true` or on an unsupported platform.
- `isNative()` mirrors `nativeCommand() !== null`.
- `enable()`/`disable()` are idempotent (no double-spawn / no throw).
- Flag parsing: `caffeinate_flags: '-i -d'` → `['-i','-d']`.
- Mock `spawn` to assert the child is killed on `disable()`.

## What does NOT change

- `src/session.js` (sessions.json + locking + idle cleanup) — unchanged.
- `src/pid.js` (PID/startup coordination) — unchanged.
- `src/commands.js` (CLI) — unchanged; `caffeinate` still ensures the server runs.
- `hooks/hooks.json` (Claude Code) — unchanged.
- The OpenCode plugin — separate effort (`docs/opencode-compatibility.md`).

## Verification

- `node --test` passes.
- Manual: `node caffeine.js caffeinate` on macOS with `tray:false` → confirm a
  `caffeinate` process appears and `pmset -g assertions` shows the assertions;
  `node caffeine.js uncaffeinate` + idle timeout → process gone.
- Manual: `tray:true` → Electron tray appears (current behavior preserved).

## Open items

1. **Orphan strategy** A vs B (see §5).
2. **Windows native** — `SetThreadExecutionState` has no clean CLI; decide whether
   to ship a tiny helper or keep Electron as the Windows default.
3. **`caffeinate_flags` / `systemd-inhibit` args validation** — reject unknown
   flags, or pass through?
4. **Phasing** — implement `darwin` first, then `linux`, then `win32`.
5. **README/CLAUDE.md** — this is a fork; the upstream DEPRECATED banner is
   inherited. Decide whether to reword it for the fork.
