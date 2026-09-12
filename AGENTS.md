# CC-Caffeine: Claude Code Sleep Prevention System

A Node.js/Electron script that prevents your computer from going to sleep while
using Claude Code through system tray integration and session management.

This is the canonical, agent-agnostic reference for the project. `CLAUDE.md`
points here.

## Architecture

The system is a modular architecture split by concern. The three concerns that
used to live together in `system-tray.js` are now separate modules so the
mechanism can become swappable (native vs Electron) and the UI optional without
touching the others.

### Core Modules

1. **caffeine.js** - Main entry point; orchestrates modules and routes commands
2. **src/commands.js** - CLI handling and process management (caffeinate/uncaffeinate/status/version)
3. **src/session.js** - Session persistence with file locking and timeout handling
4. **src/pid.js** - Atomic PID file operations and server-running checks
5. **src/server.js** - Server process management and Electron integration
6. **src/backend.js** - *Mechanism*: how sleep is prevented (`enableCaffeine`/`disableCaffeine`); dispatches to a backend by `sleep_backend` config
7. **src/native.js** - *Native backend*: prevents sleep via the OS `caffeinate` utility (`enableCaffeine`/`disableCaffeine`/`setSpawnFn`)
8. **src/poller.js** - *Decision*: when to prevent/release sleep (`updateCaffeineStatus`/`startPolling`/`stopPolling`)
9. **src/system-tray.js** - *UI*: the system tray indicator (`createIcon`/`createSystemTray`/`updateTrayIcon`/`getSystemTray`/`getSystemTrayState`/`shutdownServer`)
10. **src/electron.js** - Wraps Electron-specific functionality, loaded on demand
11. **src/config.js** - Reads user configuration from `~/.claude/plugins/cc-caffeine/config.json`
12. **opencode/cc-caffeine.mjs** - OpenCode plugin: a self-contained ESM module that maps OpenCode events to `caffeinate`/`uncaffeinate` CLI calls and shells out to the existing CLI. It is OpenCode-only (the Claude Code path uses `caffeine.js` directly) and is one file on purpose, since OpenCode loads a single plugin file

### The three concerns (mechanism / decision / UI)

| Concern | What it is | Module |
|---|---|---|
| **Mechanism** | *how* sleep is prevented | `src/backend.js` (`enableCaffeine`/`disableCaffeine` → `powerSaveBlocker`) |
| **Decision** | *when* to prevent/release (idle) | `src/poller.js` (`updateCaffeineStatus`/`startPolling`/`stopPolling`) |
| **UI** | the system tray indicator | `src/system-tray.js` (`createIcon`/`createSystemTray`/`updateTrayIcon`/`getSystemTray`/`getSystemTrayState`/`shutdownServer`) |

`backend.js` is the swappable seam: it dispatches to a backend by the
`sleep_backend` config setting. The default `electron` backend uses
`powerSaveBlocker`; the `native` backend (`src/native.js`) prevents sleep via the
OS `caffeinate` utility and runs without Electron.

### Breaking the poller ↔ system-tray cycle

`updateCaffeineStatus` (decision) used to call `updateTrayIcon` (UI), and
`shutdownServer` (UI) called `stopPolling` (decision) — a circular import. It is
resolved by **callback injection** (no functional change):

- `updateCaffeineStatus(state, onStateChange)` takes an optional callback instead
  of importing `updateTrayIcon`. The UI passes `updateTrayIcon` in.
- `startPolling` stores a `stopPolling` handle on the state object
  (`state.stopPolling`), so `shutdownServer` stops polling without importing
  `poller`.

Result: `poller` no longer imports `system-tray`, and `system-tray` no longer
imports `poller`. The callback is also the seam for a future "tray off" mode
(pass no callback → no UI update).

## User Commands

1. **caffeinate** - Adds session to JSON file and ensures server is running
2. **uncaffeinate** - Removes session from JSON file
3. **status** - Shows current session/server status
4. **server** - Starts Electron system tray application that polls JSON file for active sessions
5. **version** - Shows version information from package.json and plugin.json

## Features

- Cross-platform support (Linux, macOS, Windows)
- Headless Electron system tray (no windows, only system tray)
- JSON file for session persistence with proper-lockfile for concurrency
- Configurable session timeout (default: 15 minutes of inactivity)
- Auto-server startup when not running
- Multiple concurrent session support
- Real-time status monitoring
- Lightweight client commands (no Electron dependency for caffeinate/uncaffeinate)
- Native sleep prevention using Electron's powerSaveBlocker API
- Optional native backend (`caffeinate` utility) that runs without Electron
- Hidden from macOS dock using app.dock.hide()

## Configuration

User configuration is stored at `~/.claude/plugins/cc-caffeine/config.json`. All
settings are optional and have sensible defaults.

```json
{
   "session_timeout_minutes": 15,
   "icon_theme": "orange",
   "sleep_backend": "electron"
}
```

### Options

| Setting | Default | Description |
|---------|---------|-------------|
| `session_timeout_minutes` | `15` | Minutes of inactivity before a session expires |
| `icon_theme` | `"orange"` | Tray icon theme: `"orange"` (colored) or `"monochrome"` (black/white, auto-adapts to macOS dark mode) |
| `sleep_backend` | `"electron"` | Sleep-prevention mechanism: `"electron"` (powerSaveBlocker, with tray) or `"native"` (OS `caffeinate`, no Electron) |

## Technical Stack

- **Node.js 18+** - Runtime environment (see `engines` in package.json)
- **Electron 44+** - Cross-platform desktop application framework
- **proper-lockfile** - File locking for all concurrent access with retry logic
- **Electron powerSaveBlocker** - Native cross-platform sleep prevention (default backend)
- **OS `caffeinate`** - Sleep prevention for the native backend (no Electron)
- **Electron Tray/Menu** - System tray functionality
- **JSON file** - Session storage and communication
- **setInterval** - Background polling for session changes

## Commands Usage

### caffeinate
Enables sleep prevention for the current session (lightweight, no system tray).
```bash
node caffeine.js caffeinate
# or
npm run caffeinate
```
Accepts JSON via stdin with session_id:
```json
{"session_id": "abc123"}
```

### uncaffeinate
Disables sleep prevention for the current session (lightweight, no system tray).
```bash
node caffeine.js uncaffeinate
# or
npm run uncaffeinate
```
Accepts JSON via stdin with session_id:
```json
{"session_id": "abc123"}
```

### server
Starts the headless Electron caffeine server with system tray only.
```bash
node caffeine.js server
# or
npm run server
# or
npm start
```

### version
Shows version information from both package.json and .claude-plugin/plugin.json.
```bash
node caffeine.js version
# or
npm run version
```

## Installation & Setup

1. Install Node.js dependencies:
```bash
npm install
```

2. Create config directory:
```bash
mkdir -p ~/.claude/plugins/cc-caffeine
```

3. Make the script executable (optional):
```bash
chmod +x caffeine.js
```

4. Configure Claude Code hooks (example):
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/caffeine.js caffeinate"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/caffeine.js uncaffeinate"
          }
        ]
      }
    ]
  }
}
```

Note: The server will be auto-started by the caffeinate command when needed.

## JSON File Structure

JSON file located at: `~/.claude/plugins/cc-caffeine/sessions.json`

```json
{
  "sessions": {
    "session_id_abc123": {
      "created_at": "2025-01-08T10:30:00.000Z",
      "last_activity": "2025-01-08T10:45:00.000Z"
    }
  },
  "last_updated": "2025-01-08T10:45:00.000Z"
}
```

Sessions are removed automatically after the configured timeout (default 15
minutes of inactivity).

## File Concurrency

- **proper-lockfile** ensures atomic read/write operations
- File locking prevents corruption when multiple processes access simultaneously
- Short lock duration - Lock only held during actual read/write operations
- Built-in retry mechanism with configurable timeout
- Cross-platform file locking using OS primitives
- Atomic session operations (add/remove) within single lock to prevent race conditions

## Session Management

- Sessions auto-expire after the configured timeout (default: 15 minutes of inactivity)
- Automatic cleanup of expired sessions during every add/remove operation
- Server polls JSON file every 10 seconds for active sessions (with file locking)
- Multiple sessions can be active simultaneously
- Sleep prevention is active when at least one session is active
- Commands auto-start server if not running
- A server whose PID is no longer in `server.pid` shuts itself down on its next poll
- Only server command loads Electron system tray (lightweight client commands)
- All session operations are atomic within file locks to prevent corruption
- Session timestamps: `created_at` preserved, `last_activity` updated on subsequent calls
- All JSON file operations (read/write) are protected with proper-lockfile
- Client commands (caffeinate/uncaffeinate) work without Electron dependency

## System Tray

- Headless Electron application - no windows ever created
- Shows custom icon when caffeinated/inactive
- Context menu with Exit button
- Hidden from macOS dock using `app.dock.hide()`
- Cross-platform system tray support

## Development Scripts

```bash
npm test        # Run the test suite (node --test)
npm run lint    # Run ESLint (auto-fixes)
npm run format  # Format code with Prettier (if installed)
npm run version # Show version information from package.json and plugin.json
```

## Versioning

Follows [SemVer](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
(`CHANGELOG.md`). Bump the version and add a changelog entry in the same PR as
the change, not as a separate release step:

- New capability, integration, or config option (backward-compatible) → **minor**
- Bug fix, doc fix, or internal refactor with no behavior change → **patch**
- Breaking change to CLI args, config shape, or the session file format → **major**
  (rare pre-1.0; confirm with the user first)

Unreleased work on a feature branch doesn't get its own bump per commit — one
bump covers the whole feature when it ships.

The version string is duplicated in `package.json` and
`.claude-plugin/plugin.json`; update both together.

## Module Import Structure

The application uses CommonJS modules with a clear dependency hierarchy:

- `caffeine.js` imports from `src/commands.js` and `src/server.js`
- `src/commands.js` imports from `src/session.js`, `src/pid.js`, `src/server.js`, and `src/config.js`
- `src/server.js` imports from `src/session.js`, `src/pid.js`, `src/electron.js`, `src/system-tray.js`, `src/poller.js`, and `src/config.js`
- `src/poller.js` imports from `src/session.js`, `src/pid.js`, and `src/backend.js`
- `src/backend.js` imports from `src/electron.js` and `src/native.js`
- `src/native.js` provides the OS `caffeinate` backend on-demand
- `src/system-tray.js` imports from `src/electron.js`, `src/config.js`, `src/pid.js`, and `src/backend.js`
- `src/session.js` imports from `src/config.js`
- `src/config.js` reads `~/.claude/plugins/cc-caffeine/config.json`
- `src/electron.js` provides Electron functionality on-demand

`poller` and `system-tray` do **not** import each other (cycle broken via
callback injection — see "Breaking the poller ↔ system-tray cycle" above).

## Sleep Prevention

- Uses **Electron's powerSaveBlocker** for cross-platform sleep prevention (default)
- `powerSaveBlocker.start('prevent-app-suspension')` blocks system sleep and app suspension
- The **native backend** (`sleep_backend: "native"`) prevents sleep via the OS `caffeinate` utility and runs without Electron
- Automatically activates when sessions are active
- Gracefully releases sleep prevention on shutdown
- Works on Windows, macOS, and Linux

## File Structure

```
caffeine.js              - Main entry point and command routing
src/
├── commands.js          - Command-line interface and process management
├── session.js           - Session persistence and file locking
├── pid.js               - Atomic PID file operations and server checks
├── server.js             - Server process management and Electron integration
├── backend.js            - Mechanism: enableCaffeine / disableCaffeine
├── native.js             - Native backend: OS caffeinate utility
├── poller.js             - Decision: updateCaffeineStatus / startPolling / stopPolling
├── system-tray.js       - UI: system tray indicator
├── electron.js          - Electron-specific functionality wrapper
└── config.js            - User configuration reader
package.json             - Node.js dependencies and scripts
assets/                  - Tray icons (PNG/SVG, colored + monochrome)
~/.claude/plugins/cc-caffeine/
├── sessions.json        - JSON file with session data
└── config.json          - User configuration (optional)
```

## Error Handling

- Graceful server startup fallback if Electron unavailable
- JSON file read/write error recovery with proper-lockfile
- All operations protected by file locks to prevent race conditions
- Atomic session operations prevent data corruption during concurrent access
- Session cleanup on process termination
- Cross-platform path handling using Node.js path module
- Lock timeout handling with proper error messages
- Automatic expired session cleanup during every operation
- Proper powerSaveBlocker cleanup on server shutdown
- Graceful error handling for missing Electron APIs

## Cross-platform

- Native macOS/Windows/Linux sleep prevention via Electron
- Compatible with OS security permissions and system tray
- Background process

## Security Considerations

- Session validation and timeout protection
- No external network connections required
- File access restricted to user's home directory
- Process isolation between client commands and Electron server

## Performance Considerations

- Minimal memory footprint
- Efficient polling with 10-second intervals
- Fast startup time (< 1 seconds for Electron)
