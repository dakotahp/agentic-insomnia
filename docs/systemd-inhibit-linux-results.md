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
Idle handling: Omarchy shell (Quickshell, Wayland idle-notify), screensaver 150s, lock 300s,
  no idle suspend. hypridle and swayidle are not installed. Screensaver toggled off.
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
| A4 | PASS | `Call to Suspend failed: Operation denied due to active block inhibitor`, laptop stayed on |
| A5 | PASS | `cat` gone and lock released after both SIGTERM and SIGKILL of `systemd-inhibit` |
| A6 | PASS | SIGKILL of the Node parent releases the lock, no stray `systemd-inhibit` or `cat`. Normal release also works |
| A7 | PASS | `caught ENOENT` with a handler. Without one, Node crashes with exit 1 |
| A8 | DIFFERS | Sleep lock is **allowed** from `systemd-run --user`. Idle lock also allowed |
| A9 | SKIP | sshd is not running on this machine |
| A10 | PASS | Lock granted from a tmux server started from the desktop terminal |
| A11 | N/A | This desktop has no idle suspend. The screen still locks with the lock held, as documented |
| A12 | SKIP | Not run |
| B2 | PASS | 63 pass, 0 fail |
| B3/B4 | PASS | `cc-caffeine` lock within 12s. Server is `node caffeine.js server`. `status` shows `Sleep Backend: native` |
| B5 | PASS | Lock released within 12s. First run was confounded by this Claude Code session's own hooks keeping a second session alive, rerun after it expired |
| B6 | PASS | Lock gone after the 1 minute timeout |
| B7 | PASS | SIGKILL of the server releases the lock, no `systemd-inhibit` or `cat` left |
| B8 | PASS | Warning `sleep_backend "native" is not available on this system, using "electron"` |
| B9 | PASS | Exactly one `Native sleep prevention disabled` line with `Access denied`, none in the next 41s |

## Output

### A4

```
verify  1000 neropol 32400 systemd-inhibit sleep:idle a4  block
== systemctl suspend
Call to Suspend failed: Operation denied due to active block inhibitor
exit=1
still awake at 14:30:19
(no verify lock)
```

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

The original check assumes a GNOME or KDE auto-suspend setting. This desktop has none: idle is
handled by the Omarchy shell, which only starts a screensaver and locks the screen. It never
suspends. A control run cannot suspend, so the auto-suspend part does not apply here. A4 shows
that logind refuses a suspend request while the lock is held, which is what an idle suspend
would send.

The `verify` lock (`sleep:idle`, block) was held from 14:30:32 to about 14:34:00 with no input.
The shell log for that window:

```
14:31:58 idle-monitor: idle
14:31:58 idle-cycle-start: screensaver=150 lock=300
14:31:58 process-start: screensaver ... omarchy-launch-screensaver
14:31:58 process-exit: screensaver exitCode=1 status=0      (screensaver is toggled off)
14:34:28 lock-system: lock-timeout
14:34:28 process-start: lock omarchy-system-lock
14:34:47 idle-monitor: active
14:34:47 unlocked
```

The idle cycle started while the lock was held. The shell's idle monitor uses Wayland
idle-notify with `respectInhibitors: true`, which covers Wayland idle inhibitors only, not
logind locks. So the screen still locks, which matches the documented limit "the screen can
still blank and lock". The lock fired after the `verify` lock ended, but on the timer that
started while it was held.

## Changes needed in `docs/systemd-inhibit-plan.md`

- Fact 5 and concession 3: polkit may allow the lock outside a login session, depending on
  the distro and systemd version.
- `--no-ask-password` exists on systemd 261, but no hang or prompt was seen (A8, B9), so it
  stays out.
