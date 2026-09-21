# agentic-insomnia ☕⚡

_The successor to the now deprecated [samber/cc-caffeine](https://github.com/samber/cc-caffeine)._

Agentic tool use can make you more productive, but not when your laptop goes to sleep while running. `agentic-insomnia` keeps Claude Code and OpenCode harnesses awake while operating. No more cursor wiggling to manually keep your computer awake. The plugin keeps your computer from going to sleep only as long as it needs to, then your usual settings take effect.

## Features

- Cross-platform support for MacOS, Linux, and Windows.
  - On MacOS, Linux, and Windows it can use the OS's own sleep tool to stay awake, without Electron (when configured).
- Supports Claude Code and OpenCode.
- Adds cross-platform menu bar tray indicator:

​	![](./assets/icon-coffee-empty.png) Harness is idle

​	![](./assets/icon-coffee-full.png) Harness is running

## 🎯 Installation

Claude Code and OpenCode harnesses are both supported, and the installation method is different for each.

### Claude Code Installation

Add the repo as a Claude Code plugin marketplace, then install the plugin:

```bash
/plugin marketplace add dakotahp/agentic-insomnia
/plugin install agentic-insomnia@dakotahp
```

Installing the plugin registers its hooks automatically, so no manual hook configuration is needed. The hooks run the plugin's own bundled `caffeine.js`(via `${CLAUDE_PLUGIN_ROOT}`), so no `npx` fetch is required.

### OpenCode Installation

Install as an OpenCode plugin instead of hooks.

Open (or create) `~/.config/opencode/opencode.json` and add the
plugin:

```json
{
  "plugin": ["/absolute/path/to/agentic-insomnia/opencode/agentic-insomnia.mjs"]
}
```

Replace `/absolute/path/to/agentic-insomnia` with wherever you cloned this repo.

OpenCode picks up the plugin the next time it starts. Activity keeps the session alive, and the server releases sleep prevention after the idle timeout.

## ⚙️ Configuration (Optional)

agentic-insomnia works out of the box with **zero configuration** — the default
Electron backend needs nothing. To change behavior, create a config file at:

```
~/.claude/plugins/agentic-insomnia/config.json
```

The directory is created automatically on first run, but the file itself is not. Create it by hand and add only the settings you want. Every setting is optional and falls back to the default below.

```json
{
  "session_timeout_minutes": 15,
  "idle_timeout_minutes": 30,
  "icon_theme": "orange",
  "sleep_backend": "electron"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `session_timeout_minutes` | `15` | Minutes of inactivity before a session expires |
| `idle_timeout_minutes` | `30` | Minutes with no active session before the background server exits and removes itself. The next hook starts it again. Applies to both sleep backends. `0` disables this |
| `icon_theme` | `"orange"` | Tray icon theme: `"orange"` (colored) or `"monochrome"` (black/white, auto-adapts to macOS dark mode) |
| `sleep_backend` | `"electron"` | Sleep-prevention mechanism: `"electron"` (powerSaveBlocker + system tray) or `"native"` (the OS sleep tool: `caffeinate` on MacOS, `systemd-inhibit` on Linux, a PowerShell power request on Windows; no Electron, no tray) |

### Manual Claude Code Hook Configuration

Hooks will be configured automatically if you import the project as a Claude Code plugin.

Otherwise, configure your Claude Code hooks manually, pointing each command at the local `caffeine.js` (replace `/path/to/agentic-insomnia` with your checkout):

```json
{
   "UserPromptSubmit": [
     {
       "hooks": [
         {
           "type": "command",
           "command": "node /path/to/agentic-insomnia/caffeine.js caffeinate"
         }
       ]
     }
   ],
   "PreToolUse": [
     {
       "hooks": [
         {
           "type": "command",
           "command": "node /path/to/agentic-insomnia/caffeine.js caffeinate"
         }
       ]
     }
   ],
   "PostToolUse": [
     {
       "hooks": [
         {
           "type": "command",
           "command": "node /path/to/agentic-insomnia/caffeine.js caffeinate"
         }
       ]
     }
   ],
   "Notification": [
     {
       "hooks": [
         {
           "type": "command",
           "command": "node /path/to/agentic-insomnia/caffeine.js uncaffeinate"
         }
       ]
     }
   ],
   "Stop": [
     {
       "hooks": [
         {
           "type": "command",
           "command": "node /path/to/agentic-insomnia/caffeine.js uncaffeinate"
         }
       ]
     }
   ],
   "SessionEnd": [
     {
       "hooks": [
         {
           "type": "command",
           "command": "node /path/to/agentic-insomnia/caffeine.js uncaffeinate"
         }
       ]
     }
   ]
}
```

### Switching to the native backend

Set `sleep_backend` to `"native"` to prevent sleep with your operating system's own tool instead of Electron. The server then runs as a plain Node process with no system tray, so Electron is not needed to keep the system awake.

```json
{
  "sleep_backend": "native"
}
```

| OS | Tool used |
|----|-----------|
| MacOS | `caffeinate -i` |
| Linux (systemd) | `systemd-inhibit --what=sleep:idle --mode=block` |
| Windows 10 and 11 | The built-in Windows PowerShell, holding a system power request |
| Anything else | None. agentic-insomnia logs a warning and uses the Electron backend. |

Run `node caffeine.js status` to see which backend is in use. The server reads the config when it starts, so restart it after a change: `kill "$(cat ~/.claude/plugins/agentic-insomnia/server.pid)"`, or on Windows in PowerShell: `Stop-Process -Id (Get-Content "$HOME\.claude\plugins\agentic-insomnia\server.pid")`. The next hook starts a new server.

The Electron backend remains the cross-platform default.

#### Linux notes

Linux is supported and works by holding a standard systemd lock (`systemd-inhibit --what=sleep:idle`).

- It needs systemd (logind) to work. This covers most distros: Ubuntu, Debian, Fedora, Arch and its derivatives (EndeavourOS, Manjaro, CachyOS), openSUSE, Linux Mint, Pop!_OS, NixOS, and similar. Distros without systemd, such as Void, Alpine, Artix, Gentoo with OpenRC, Devuan, or WSL without systemd, fall back to Electron.
- It blocks suspend, hibernate, and the idle action. On most desktops, the screen should also stay unlocked. This is expected, not tested.
- On GNOME, suspend is still blocked, but by logind refusing it, not by GNOME's own power tool. GNOME still tries and fails, logs an error, and the screen still blanks and locks. Expected, not tested.
- The lock is released when sessions go idle, when the server stops, and also when the server crashes.

#### Windows notes

Windows has no command like `caffeinate`, so agentic-insomnia starts the Windows PowerShell that comes with Windows 10 and 11. PowerShell holds a system power request, the same kind Electron uses. Windows support is new and not yet tested on many machines.

- While a session is active, `powercfg /requests` (in an administrator terminal) lists `agentic-insomnia: coding agent session active`.
- The request is released when sessions go idle, when the server stops, and also when the server crashes.
- PowerShell takes a second or two to start each time sessions become active. Hooks do not wait for it. If it is too slow on your machine, use `"electron"`.
- On laptops with Modern Standby, when on battery, Windows ends the request 5 minutes after your "sleep after" time. When plugged in, there is no limit. The Electron backend has the same limit.
- Closing the lid, pressing the power button, or choosing Sleep still puts the computer to sleep.
- The screen can still turn off and lock.
- Some managed work computers block PowerShell from calling Windows functions (Constrained Language Mode). The server then logs the reason once and does not prevent sleep. Use `"electron"` on those computers.

## 📋 Local Development Requirements

- Node.js >= 22.12.0 (your coffee of choice; `.node-version` pins the one CI uses)
- Electron (included automatically, like sugar in your espresso)

## 🛠 Contributing

See [architecture documentation](ARCHITECTURE.md) for how the pieces fit together, how the tests work, and how to add a sleep backend.

## 🚀 Run without Claude Code

Run from the repo directory (after `npm install`):

```bash
# Start server + system tray
# (optional - will be started automatically)
node caffeine.js server

claude -p 'Write 10 pages of "lorem ipsum"'

node caffeine.js status
```

Manual switch:

```bash
# Activate caffeine for your coding session
echo '{"session_id": "session-abcd"}' | node caffeine.js caffeinate

# Your session is now protected!
# Claude can keep working while you sip coffee

# When you're done (or after 15 minutes of auto-cleanup)
echo '{"session_id": "session-abcd"}' | node caffeine.js uncaffeinate
```

## 💫 Fuel the Revolution

- ⭐️ **Star this repo**
- ☕️ **Buy me a coffee**
- 🚀 **Sponsor the revolution**

*Every sponsor gets a virtual high-five and the knowledge that somewhere, a developer is "coding" from a ski track because of you.* ✨

## 📄 License

MIT. Use it, modify it, share it. Copyright © 2025 Samuel Berthe.
