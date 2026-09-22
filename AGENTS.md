# Agentic Insomnia

Keeps the computer awake while Claude Code, OpenCode, or Codex works. Short-lived CLI clients
record sessions in a locked JSON file. A long-lived server polls it and holds a sleep
lock while any session is active.

Read `ARCHITECTURE.md` before changing server startup, sessions, or a backend.
User-facing install and config are in `README.md`.

## Commands

```bash
npm test                                   # all suites (node --test)
node --test test/native.test.js            # one suite
npm run lint                               # ESLint, fails on violations (as CI does)
npm run toc                                # regenerate the README table of contents
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
| Integrations | `hooks/hooks.json`, `opencode/agentic-insomnia.mjs` |
| Plugin manifests | `plugin.json` (Codex), `.claude-plugin/plugin.json` (Claude Code) |

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
- `opencode/agentic-insomnia.mjs` stays one file with only a default export.
- CI (`.github/workflows/ci.yml`) runs lint and tests on Ubuntu. Tests must not depend
  on the host OS: pin the platform with `native.setDependencies` or `pid.setDependencies`, and mock
  config/electron through `require.cache`.
- `test/pid.test.js` spawns `ps` and fails with EPERM in sandboxes. That is not a bug.
- `hooks/hooks.json` is shared by Claude Code and Codex. Codex does not define every Claude
  Code event, so a hook on an event Codex lacks silently never fires there.
  `test/plugin-manifests.test.js` fails on one unless it is listed as Claude-only on purpose.
- The version appears in `package.json`, `.claude-plugin/plugin.json`, and `plugin.json`. CI
  fails if they differ, and release-please bumps all three. A new manifest with a version
  field must be added to `release-please-config.json` and to the CI check together.
- The README table of contents is generated. After changing an `##` or `###` heading, run
  `npm run toc` and commit the result. `test/readme-toc.test.js` fails when it is stale, and
  also fails on an in-page link that points at no heading.
- Manual hook instructions point at `hooks/hooks.json` rather than copying it. An inline copy
  drifted once already: it kept a `Notification` block after that hook was removed.
- Update `README.md` for user-visible changes, `ARCHITECTURE.md` for design changes.

## Versioning and releases

SemVer. release-please (`.github/workflows/release-please.yml`) makes every release.

- Do not change the version or `CHANGELOG.md` in a feature PR.
- Commit messages are Conventional Commits. They choose the next version and become the
  changelog:
  - `fix:` bug fix or behavior-preserving change users notice: patch
  - `feat:` new capability or config option: minor
  - `feat!:` or a `BREAKING CHANGE:` footer, for breaking CLI, config, or session file
    changes: major (confirm with the user first)
  - `docs:`, `test:`, `refactor:`, `chore:`, and `ci:` do not trigger a release
- On each push to `master`, release-please opens or updates a release PR. It bumps
  `package.json`, `.claude-plugin/plugin.json`, `.release-please-manifest.json`, and
  `CHANGELOG.md`. Merging that PR creates the `vX.Y.Z` tag and the GitHub release.
- Release PRs are opened by the Actions bot, so CI does not run on them.
