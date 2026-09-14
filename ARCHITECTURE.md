# Architecture

This guide explains how cc-caffeine works inside, for people who want to read or change the
code. For installing and configuring it, see the [README](README.md).

## The short version

cc-caffeine keeps a computer awake while an AI coding harness (Claude Code or OpenCode) is
working, and lets it sleep again once the harness goes idle.

It runs two kinds of processes:

- **Clients** are short-lived. The harness runs `caffeine.js caffeinate` or
  `caffeine.js uncaffeinate` on its events. A client records the session in a JSON file, makes
  sure a server is running, and exits. Clients never load Electron, so hooks stay fast.
- **The server** is long-lived. Every 5 seconds it reads the session file. While at least one
  session is active, it holds a sleep lock. When no session is active, it releases the lock.

The session file is the only channel between them. Clients and the server never talk directly.

```mermaid
flowchart LR
  subgraph Harness
    CC[Claude Code hooks]
    OC[OpenCode plugin]
  end
  subgraph Server[caffeine.js server]
    P[poller] --> B[backend]
    P -.->|state change| T[system tray]
  end
  CC -->|caffeinate / uncaffeinate| CLI[caffeine.js client]
  OC -->|caffeinate / uncaffeinate| CLI
  CLI -->|write, locked| SF[(sessions.json)]
  CLI -->|start if not running| Server
  P -->|read every 5s, locked| SF
  B --> E[Electron powerSaveBlocker]
  B --> M[macOS caffeinate]
  B --> L[Linux systemd-inhibit]
```

## Repository layout

| Path | Role |
|------|------|
| `caffeine.js` | Entry point. Routes `caffeinate`, `uncaffeinate`, `server`, `status`, `version`. |
| `src/commands.js` | Client commands: read the hook's JSON from stdin, update the session file, start the server. |
| `src/session.js` | The session file: add, remove, expire, read. Every access is locked. |
| `src/pid.js` | The server PID file, the startup marker, and "is a real server running?" checks. |
| `src/server.js` | Starts the server, as an Electron app or as a plain Node process. |
| `src/poller.js` | **Decision**: when to hold or release the sleep lock. |
| `src/backend.js` | **Mechanism** seam: picks a backend and dispatches to it. |
| `src/native.js` | Native backend: `caffeinate` on macOS, `systemd-inhibit` on Linux. |
| `src/system-tray.js` | **UI**: the tray icon and its Exit menu. Also owns server shutdown. |
| `src/electron.js` | Loads Electron only when it is needed. |
| `src/config.js` | Reads `~/.claude/plugins/cc-caffeine/config.json` once and caches it. |
| `hooks/hooks.json` | Claude Code hook registration used by the plugin install. |
| `opencode/cc-caffeine.mjs` | OpenCode plugin. One file, because OpenCode loads one plugin file. |
| `test/` | `node --test` suites. |

## Integrations

Both harnesses end up calling the same two client commands, so all session and timeout logic
lives in one place.

- **Claude Code** runs hooks from `hooks/hooks.json`. `UserPromptSubmit`, `PreToolUse`, and
  `PostToolUse` call `caffeinate`. `Notification`, `Stop`, and `SessionEnd` call
  `uncaffeinate`. Each hook pipes `{"session_id": "..."}` to the command's stdin.
- **OpenCode** has no external hooks, so `opencode/cc-caffeine.mjs` listens to in-process
  events. `session.created`, `command.executed`, and `message.updated` map to `caffeinate`.
  `session.idle` and `session.deleted` map to `uncaffeinate`. The plugin then runs the same
  CLI.

The `uncaffeinate` calls are a shortcut, not the only release path. If a harness crashes and
never sends one, the session still expires after the idle timeout.

## The session file

Location: `~/.claude/plugins/cc-caffeine/sessions.json`

```json
{
  "sessions": {
    "abc123": {
      "created_at": "2025-01-08T10:30:00.000Z",
      "last_activity": "2025-01-08T10:45:00.000Z"
    }
  },
  "last_updated": "2025-01-08T10:45:00.000Z"
}
```

- `caffeinate` adds a session, or updates `last_activity` if it exists.
  `uncaffeinate` removes it.
- A session expires after `session_timeout_minutes` (default 15) without activity. Expired
  sessions are removed on every add, remove, and poll.
- Many hooks can fire at once, so every read and write holds a
  [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) lock. The lock is held
  only for the read-modify-write itself.

## Server lifecycle

### Starting exactly one server

Hooks fire in bursts, and several clients may find "no server" at the same moment. Startup is
guarded so only one of them starts a server:

1. Inside a lock on `server.pid`, the client checks for a running server and for a recent
   `server.starting` marker (30 second grace period).
2. If neither exists, it writes the marker and releases the lock. Other clients now see the
   marker and back off.
3. It spawns the server detached: `npm run server` (Electron) or `npm run native-server`
   (plain Node), based on the resolved backend.
4. The server takes the same lock and writes its own PID.

"Is a server running?" means more than "the PID is alive". `pid.js` also reads that process's
command line (`ps -ww`, or `wmic` on Windows) and checks that it is a caffeine server. A PID
reused by an unrelated process is not trusted.

### Running

The server calls `startPolling(state, 5000, onStateChange, onOwnershipLost)`. On each tick the
poller:

1. checks that `server.pid` still names this server; if another server owns it, the poller
   stops and calls `onOwnershipLost(state)` (see "Stopping"),
2. removes expired sessions,
3. counts active sessions,
4. calls `enableCaffeine(state)` or `disableCaffeine(state)` if the answer changed,
5. calls `onStateChange(state)` if a UI passed one in.

`state` is a plain object that the server owns. Backends keep their handles on it, for example
`powerSaveBlockerId` or `caffeinateProcess`.

### Stopping

`SIGINT`, `SIGTERM`, or the tray's Exit item call `shutdownServer(state)`. It stops polling,
releases the sleep lock, destroys the tray, and removes the PID file.

A server also stops when another server has replaced it. If a startup race ever leaves two
servers running, only one owns `server.pid`. The other sees this on its next poll, runs
`shutdownServer(state)`, and exits, so it cannot keep a tray icon or sleep lock forever. A
missing or unreadable PID file does not count as replaced.

## Three concerns, kept apart

| Concern | Question | Module |
|---------|----------|--------|
| Decision | *When* should the machine stay awake? | `poller.js` |
| Mechanism | *How* is sleep prevented? | `backend.js`, `native.js` |
| UI | *What* does the user see? | `system-tray.js` |

The poller and the tray used to import each other. Two small injections break that loop:

- The poller takes an optional `onStateChange` callback instead of importing the tray. The
  tray passes `updateTrayIcon`. The native server passes nothing, so it has no UI.
- `startPolling` stores `state.stopPolling`, so shutdown can stop the poller without importing
  it.

## Sleep backends

| Backend | Config value | How it prevents sleep | Server process | Tray |
|---------|--------------|-----------------------|----------------|------|
| Electron | `"electron"` (default) | `powerSaveBlocker.start('prevent-app-suspension')` | Electron | Yes |
| Native, macOS | `"native"` | child process `caffeinate -i` | Node | No |
| Native, Linux | `"native"` | child process `systemd-inhibit ... cat` | Node | No |

### Choosing a backend

`getSleepBackend()` in `backend.js` makes the choice once per process and caches it:

- Config is not `"native"`: use `electron`.
- Config is `"native"` and `native.isAvailable()` is true: use `native`.
- Otherwise: log a warning and use `electron`.

`isAvailable()` looks for `caffeinate` on `PATH` on macOS. On Linux it needs both
`/run/systemd/system` (the machine booted with systemd) and `systemd-inhibit` on `PATH`. Every
other platform returns false.

The client uses the same function to pick which server script to spawn. The server uses it to
dispatch. Caching keeps those two answers the same for the life of the process.

### When a native tool fails

A native tool can fail to start (for example, the binary is missing) or exit right away (for
example, polkit denies the lock). If either happens within 2 seconds of starting, `native.js`
records the reason on `state.nativeFailure`, logs it once, and ignores later enable calls.
Without this guard, the poller would respawn a failing process every 5 seconds.

A tool that exits later, after running normally, is treated as a normal stop. The next poll
starts it again.

The server does not switch to Electron after a failure at runtime. That would mean restarting
as a different kind of process.

### The Linux backend in detail

The server runs:

```
systemd-inhibit --what=sleep:idle --who=cc-caffeine --why="Claude Code session active" --mode=block cat
```

with stdin as a pipe from the server and stderr captured for error messages.

- `systemd-inhibit` asks logind for a **block** lock on `sleep` (suspend and hibernate) and
  `idle` (logind's idle action). It holds the lock while its child command runs.
- The child is `cat`, which reads the pipe from the server and never exits on its own.
- **Normal release**: the server kills `systemd-inhibit`. systemd starts its child with a
  "kill me when my parent dies" signal, so `cat` ends too, and logind drops the lock.
- **Crash release**: if the server dies, even by `SIGKILL`, the OS closes the pipe. `cat` sees
  end of input and exits, `systemd-inhibit` exits, and the lock goes away. `sleep infinity`
  would not do this, which is why the child is `cat`.

Known limits:

- Needs systemd and logind. Other init systems fall back to Electron.
- Works from a login session. Processes outside a session may be denied the lock, depending on
  the distro's polkit rules. Arch with systemd 261 allowed it from `systemd-run --user`.
- Does not stop screen blanking or locking, the same as Electron's `prevent-app-suspension`.
- Does not block lid-close suspend (`handle-lid-switch`).
- Electron on Linux talks to the desktop's session manager over D-Bus. This backend talks to
  logind, which refuses suspend requests while the lock is held. Tested on Omarchy (Arch),
  systemd 261, Hyprland. A desktop idle screen lock that uses Wayland idle inhibitors still
  locks the screen.

## Configuration

`config.js` merges `~/.claude/plugins/cc-caffeine/config.json` over its defaults and caches
the result for the life of the process. A running server keeps its config until it restarts.
See the README for the settings.

## Testing

Run `npm test` (Node's built-in `node --test`) and `npm run lint`. `npm run lint` fails on
violations; `npm run lint:fix` fixes what it can.

CI (`.github/workflows/ci.yml`) is one job on Ubuntu, on the Node version in `.node-version`.
It checks that `package.json` and `.claude-plugin/plugin.json` have the same version, then runs
lint, the tests, and `node caffeine.js version`. Tests must pass on every OS, so they never
depend on the machine they run on:

- `native.js` takes its dependencies through `setDependencies({ spawn, platform,
  commandExists, isSystemdBooted, now })`. Tests pass a fake child process, a fixed platform,
  and a fake clock.
- Modules that read config or Electron are replaced in `require.cache` before the module
  under test loads. See `test/backend-native.test.js`.
- Each test reloads the module under test, so cached state (like the resolved backend) starts
  fresh.

Some behavior can only be proven on a real machine, such as whether a desktop honors a logind
lock. Check those by hand and describe what you checked in the pull request.

## Adding a sleep backend

1. Write `enableCaffeine(state)` and `disableCaffeine(state)`. Both must be safe to call twice.
   Keep any handles on `state`.
2. Write an availability check, and record startup failures on `state` so the poller does not
   retry forever.
3. Wire it into `getSleepBackend()` and the dispatch in `backend.js`.
4. If it does not need Electron, reuse the plain Node server path in `server.js`.
5. Add tests with injected dependencies and a fixed platform.
6. Update the README config table, this file, `AGENTS.md`, and `CHANGELOG.md`. Bump the version
   in both `package.json` and `.claude-plugin/plugin.json`.
