# `systemd-inhibit` Linux Verification Results

Run on 2026-09-12 against branch `worktree-systemd-inhibit-plan` (0.6.0).

## Environment

```
NAME="Omarchy"   (Arch Linux based)
systemd 261 (261.2-1-arch)
booted with systemd
/usr/bin/systemd-inhibit
Hyprland / wayland
Session 1: Type=wayland Class=user Active=yes Remote=no
Session 2: Class=manager (the user service manager has its own logind session)
node v26.8.2
Idle daemon: hypridle (screensaver at 150s, lock at 152s, no suspend listener)
logind: no IdleAction set, HandlePowerKey=ignore, InhibitDelayMaxSec=15
sshd: inactive
```

`npm test`: 63 pass, 0 fail. `npm run lint`: clean.

## Results

| Check | Result | Note |
|---|---|---|
| A1 | PASS | Prints "No inhibitors." and exits 0 at once |
| A2 | PASS | All flags listed, including `--no-ask-password`. `sleep:idle` with it exits 0 |
| A3 | PASS | `verify` row shows `sleep:idle` and `block` |
| A4 | PENDING | HUMAN: needs approval to run `systemctl suspend` |
| A5 | PASS | `cat` gone and lock released after both SIGTERM and SIGKILL of `systemd-inhibit` |
| A6 | PASS | SIGKILL of the Node parent releases the lock, no stray `systemd-inhibit` or `cat`. Normal release also works |
| A7 | PASS | `caught ENOENT` with a handler. Without one, Node crashes with exit 1 |
| A8 | DIFFERS | Sleep lock is **allowed** from `systemd-run --user`. Idle lock also allowed |
| A9 | SKIP | sshd is not running on this machine |
| A10 | PASS | Lock granted from a tmux server started from the desktop terminal |
| A11 | PENDING | HUMAN: this desktop has no idle suspend configured, see below |
| A12 | PENDING | HUMAN, optional |
| B2 | PASS | 63 pass, 0 fail |
| B3/B4 | PASS | `cc-caffeine` lock within 12s. Server is `node caffeine.js server`. `status` shows `Sleep Backend: native` |
| B5 | PASS | Lock released within 12s. First run was confounded by this Claude Code session's own hooks keeping a second session alive, rerun after it expired |
| B6 | PASS | Lock gone after the 1 minute timeout |
| B7 | PASS | SIGKILL of the server releases the lock, no `systemd-inhibit` or `cat` left |
| B8 | PASS | Warning `sleep_backend "native" is not available on this system, using "electron"` |
| B9 | PASS | Exactly one `Native sleep prevention disabled` line with `Access denied`, none in the next 41s |

## Output

### A6

```
== A6 SIGKILL node
node pid 13361 inhibit pid 13369
verify  1000 neropol 13369 systemd-inhibit sleep:idle node-test  block
probes.sh: line 34: 13361 Killed  node "$T/hold.js"
no systemd-inhibit
no cat
(no verify lock)
== A6 normal release
node pid 13387 inhibit pid 13395
at 1s:
verify  1000 neropol 13395 systemd-inhibit sleep:idle node-test  block
inhibit exit null SIGTERM
at 4s:
(no verify lock)
```

### A8

```
== A8 sleep outside session
Running as unit: run-p13436-i5696.service
          Finished with result: success
Main processes terminated with: code=exited, status=0/SUCCESS
               Service runtime: 2.035s
exit=0
== A8 idle outside session
Running as unit: run-p13450-i30228.service
          Finished with result: success
Main processes terminated with: code=exited, status=0/SUCCESS
               Service runtime: 2.033s
exit=0
```

`/usr/share/polkit-1/rules.d` has no rule for `org.freedesktop.login1.inhibit-*`.
`/etc/polkit-1/rules.d` is not readable by the user. systemd 256+ gives the user service
manager its own logind session (class `manager`), so `systemd-run --user` is probably not
"outside any session" any more. The plan's claim that such processes are denied is not true
here.

### A11

Pending. Omarchy's hypridle config has no suspend listener and logind has no `IdleAction`,
so this desktop never suspends on idle by default. A control run would not suspend, so the
check as written proves nothing here.

hypridle honors systemd `idle` inhibitors by default (`ignore_systemd_inhibit = false`). If
that holds, the `cc-caffeine` lock also stops the screensaver and screen lock on Hyprland,
which contradicts "the screen can still blank and lock".

## Changes needed in `docs/systemd-inhibit-plan.md`

- Fact 5 and concession 3: polkit may allow the lock outside a login session, depending on
  the distro and systemd version.
- `--no-ask-password` exists on systemd 261, but no hang or prompt was seen (A8, B9), so it
  stays out.
