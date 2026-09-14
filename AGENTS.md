# CC-Caffeine

Keeps the computer awake while Claude Code or OpenCode works. Short-lived CLI clients
record sessions in a locked JSON file. A long-lived server polls it and holds a sleep
lock while any session is active.

Read `ARCHITECTURE.md` before changing server startup, sessions, or a backend.
User-facing install and config are in `README.md`.

## Commands

```bash
npm test                                   # all suites (node --test)
node --test test/native.test.js            # one suite
npm run lint                               # ESLint, fails on violations (as CI does)
npm run lint:fix                           # ESLint with auto-fix
node caffeine.js status                    # server, backend, sessions
echo '{"session_id":"x"}' | node caffeine.js caffeinate    # also starts the server
node caffeine.js server                    # foreground server, to see logs
```

No build step. CommonJS, Node 22.12+ (`.node-version` pins the version CI and local dev use).

## Map

| Concern | Module |
|---|---|
| CLI routing | `caffeine.js`, `src/commands.js` |
| Session file (locked) | `src/session.js` |
| PID file, heartbeat, startup marker | `src/pid.js` |
| Server startup | `src/server.js` |
| Decision: when to hold the lock | `src/poller.js` |
| Mechanism: backend choice | `src/backend.js` |
| caffeinate / systemd-inhibit / PowerShell power request | `src/native.js` |
| Tray UI and shutdown | `src/system-tray.js` |
| Lazy Electron loader | `src/electron.js` |
| Config (cached) | `src/config.js` |
| Integrations | `hooks/hooks.json`, `opencode/cc-caffeine.mjs` |

## Rules and gotchas

- Client commands must never call `getElectron()`.
- `poller` and `system-tray` must not import each other. Use the `onStateChange`
  callback and `state.stopPolling`.
- A server exits on its next poll when `server.pid` names a different server
  (`onOwnershipLost` in `startPolling`). Keep that path when changing startup.
- Use `getSleepBackend()` for backend decisions, never `config.sleep_backend`.
- Backend enable/disable must be safe to call twice and keep handles on `state`.
- The Linux command ends in `cat`, and the Windows script ends reading stdin, on purpose:
  both release the lock if the server dies. Do not replace them with `sleep infinity` or a
  timer.
- The Windows PowerShell script must not contain double quotes or use `Add-Type`. See
  `ARCHITECTURE.md`.
- On Windows, `validatePid` trusts a fresh `server.heartbeat` instead of starting PowerShell.
  Servers must keep refreshing it on every poll.
- Config is cached per process. Restart the server after config changes.
- The background server discards its logs. Debug with a foreground server.
- `opencode/cc-caffeine.mjs` stays one file with only a default export.
- CI (`.github/workflows/ci.yml`) runs lint and tests on Ubuntu. Tests must not depend
  on the host OS: pin the platform with `native.setDependencies` or `pid.setDependencies`, and mock
  config/electron through `require.cache`.
- `test/pid.test.js` spawns `ps` and fails with EPERM in sandboxes. That is not a bug.
- Update `README.md` for user-visible changes, `ARCHITECTURE.md` for design changes.

## Versioning

SemVer plus `CHANGELOG.md` (Keep a Changelog). Bump once per feature, in the same PR.

- New capability or config option: minor
- Fix or refactor with no behavior change: patch
- Breaking CLI, config, or session file change: major (confirm with the user first)

Update the version in both `package.json` and `.claude-plugin/plugin.json`. CI fails
when they differ.
