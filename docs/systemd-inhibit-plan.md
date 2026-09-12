# Linux Native Backend: `systemd-inhibit`

> Status: validated. Implemented as 0.6.0 and tested on Omarchy (Arch), systemd 261, Hyprland.
> See `docs/systemd-inhibit-linux-results.md`. Not tested: SSH logins (A9), lid close (A12),
> and idle suspend on GNOME or KDE (A11 does not apply on Omarchy). `--no-ask-password` exists
> on systemd 261 but is left out, since no hang or prompt was seen.

## Verdict

Yes, it is doable. `systemd-inhibit` fits the existing `native` backend with small changes.
The server already runs as plain Node for `native`, so Linux gets a no-Electron, no-tray path.

The main concessions:

- It works only on systemd distros that run logind.
- It uses a different system layer than Electron does, so desktop auto-suspend needs a manual check.
- A failure at runtime does not switch to Electron.

## What was checked

These facts come from the systemd source (`src/login/inhibit.c`, `man/systemd-inhibit.xml`,
`src/login/org.freedesktop.login1.policy`) and Chromium's `power_save_blocker_linux.cc`.

1. **A command is required.** With no command, `systemd-inhibit` lists inhibitors and exits.
2. **The lock lives as long as the command.** The lock is taken before the command starts and
   released when the command exits.
3. **Killing `systemd-inhibit` kills the command.** The child is forked with
   `FORK_DEATHSIG_SIGTERM`, so it gets SIGTERM when the parent dies. No orphan is left.
4. **The command keeps stdin.** The fork does not use `FORK_NULL_STDIO`, so the child reads
   the stdin we give `systemd-inhibit`.
5. **Polkit defaults** for `inhibit-block-sleep`: `allow_active=yes`, `allow_inactive=yes`,
   `allow_any=auth_admin_keep`. A normal desktop login works. A process outside any logind
   session may be denied, depending on the distro's polkit rules. On Arch with systemd 261,
   `systemd-run --user` was allowed.
   `inhibit-block-idle` is `yes` for all three.
6. **Electron uses a different layer.** On Linux, `powerSaveBlocker` calls
   `org.gnome.SessionManager` over D-Bus, with `org.freedesktop.PowerManagement` as a fallback.
   It does not use logind.

## Design

### Config

Keep `sleep_backend: "native"`. It now means "the OS sleep tool for this platform".

| Platform | `native` runs |
|---|---|
| macOS | `caffeinate -i` (unchanged) |
| Linux + systemd | `systemd-inhibit` (new) |
| Anything else | falls back to `electron`, with a warning |

Alternative: add an explicit `sleep_backend: "systemd"` value. This is more explicit, but the
config grows one value per platform and users must pick per machine. Not recommended.

### The command

```
systemd-inhibit --what=sleep:idle --who=cc-caffeine --why="Claude Code session active" --mode=block cat
```

Spawn it with `stdio: ['pipe', 'ignore', 'pipe']`.

- `sleep` blocks suspend and hibernate. `idle` blocks logind's `IdleAction`.
- `cat` reads the stdin pipe from the Node server and holds until the pipe closes.
- To release, call `child.kill()`. `systemd-inhibit` exits and its death signal ends `cat`.
- If the Node server crashes, the OS closes the pipe. `cat` reads EOF and exits, so the lock
  is released. `sleep infinity` would not do this: an orphaned `systemd-inhibit` would hold
  the lock forever.
- stderr is captured so a polkit denial or logind error can be logged.
- Add `--no-ask-password` so polkit never tries to prompt. Confirm the flag exists on the
  oldest systemd we support; drop it if not (stdin is a pipe, not a TTY, so no prompt opens).

### Modules

| File | Change |
|---|---|
| `src/native.js` | Add `resolveNativeCommand(platform)` that returns `{ cmd, args, stdio }` or `null`. `enableCaffeine` uses it instead of the hardcoded `caffeinate`. Add `isAvailable()`. Make platform and availability injectable for tests, like `setSpawnFn`. |
| `src/native.js` | Handle the child `error` event (for example `ENOENT`). Today an unhandled `error` event crashes the server. |
| `src/native.js` | If the child fails or exits within about 2 seconds, set `state.nativeFailure` with the reason, log it once, and make `enableCaffeine` return early after that. Without this guard the poller respawns a failing child every 5 seconds. |
| `src/backend.js` | Add `getSleepBackend()`. It returns `native` only when config asks for it and `native.isAvailable()` is true, otherwise `electron`. Use it in place of the direct `getConfig().sleep_backend` checks. |
| `src/server.js` | Replace the local `getBackend()` with `getSleepBackend()` from `backend.js`. This keeps the npm script choice and the mechanism in agreement. |

`isAvailable()` on Linux checks two things: `/run/systemd/system` exists (the standard
"booted with systemd" test), and `systemd-inhibit` is found on `PATH`. On macOS it checks for
`caffeinate` on `PATH`.

No changes to `poller.js`, `system-tray.js`, `session.js`, or the session file format.
`shutdownServer` already calls `disableCaffeine`, so shutdown is covered.

### Data flow

```
hook -> caffeinate CLI -> sessions.json
                       -> getSleepBackend() -> "native" -> npm run native-server
native server -> poller (every 5s) -> native.enableCaffeine
              -> spawn systemd-inhibit ... cat   (lock held)
sessions expire -> poller -> native.disableCaffeine -> child.kill() (lock released)
server crash -> stdin pipe closes -> cat exits -> lock released
```

## Concessions

1. **No tray.** Same as the macOS native backend. Accepted.
2. **systemd only.** Void, Alpine, Artix, Gentoo with OpenRC, and WSL without systemd fall back
   to Electron. elogind systems usually lack the `systemd-inhibit` binary, so they fall back too.
3. **A logind session is needed.** Desktop logins work. Processes started outside a
   session may be denied, depending on the distro's polkit rules.
4. **Desktop auto-suspend is not proven.** GNOME and KDE auto-suspend should call logind, which
   refuses while a block inhibitor is held. Electron instead talks to the GNOME session manager.
   The behavior can differ, so test it on a real desktop before calling it done.
5. **The screen can still blank and lock.** This matches Electron's `prevent-app-suspension`.
6. **Closing the lid still suspends.** Blocking that needs `handle-lid-switch`, which is out of
   scope. It could become an option later.
7. **A runtime failure does not switch to Electron.** If polkit denies the lock after the
   server starts, the server logs the reason and keeps running without sleep prevention.
   Switching backends mid-run would mean restarting the server under Electron. Not worth it.
8. **Admins can override.** `systemctl suspend --ignore-inhibitors` still suspends.

## Testing

Unit tests (`node --test`, no real processes):

- `resolveNativeCommand('darwin')` returns `caffeinate -i`.
- `resolveNativeCommand('linux')` returns the `systemd-inhibit` args above, with a stdin pipe.
- `resolveNativeCommand('win32')` returns `null`.
- `enableCaffeine` on Linux spawns `systemd-inhibit` and stores the child.
- A child `error` event sets `nativeFailure` and does not throw.
- A child that exits early sets `nativeFailure`, and the next `enableCaffeine` does not spawn.
- `getSleepBackend()` returns `electron` when config says `native` but `isAvailable()` is false.

Manual check on a systemd desktop (Arch with GNOME or KDE):

1. Set `"sleep_backend": "native"` and send a `caffeinate` hook.
2. `systemd-inhibit --list` shows `cc-caffeine`.
3. `systemctl suspend` is refused.
4. Set desktop auto-suspend to 1 minute and wait. The machine stays awake.
5. Let the session expire. The inhibitor disappears from the list.
6. `kill -9` the server. The inhibitor disappears from the list.
7. Over SSH, repeat steps 1 to 3.

CI: an optional integration test can run when `/run/systemd/system` exists. GitHub's Ubuntu
runners boot systemd, but logind session state there is uncertain, so skip the test on failure
rather than fail the build.

## Work order

1. **Harden `native.js`.** Handle `error`, add the early-exit guard. This also fixes the current
   crash when `native` is set on Linux.
2. **Add the per-platform command** and the `systemd-inhibit` args.
3. **Add `getSleepBackend()`** with the Electron fallback, and use it in `server.js` and
   `backend.js`.
4. **Docs and release.** Update `README.md` (the native section says macOS only), `AGENTS.md`,
   `CHANGELOG.md`, and bump `package.json` and `.claude-plugin/plugin.json` to 0.6.0.
5. **Manual check** on a real systemd desktop, per the list above.

Steps 1 to 3 can be one PR. Each has its own unit tests.
