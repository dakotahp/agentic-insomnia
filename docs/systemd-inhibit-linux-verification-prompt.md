# Prompt: Verify `systemd-inhibit` on a Real Linux Machine

Paste everything below the line into a Claude Code session on the Linux laptop, started from
the cc-caffeine repo root. It is written for a session with no prior context.

---

You are on a Linux laptop, in the cc-caffeine repo. Your job is to verify facts on this real
machine, not to write product code. Read `docs/systemd-inhibit-plan.md` first. It proposes a
Linux native backend that holds a sleep lock with:

```
systemd-inhibit --what=sleep:idle --who=cc-caffeine --why="Claude Code session active" --mode=block cat
```

The plan rests on claims that were read from source code but never run on Linux. Test each one
here. Record PASS, FAIL, or SKIP with the exact output. At the end, write the results to
`docs/systemd-inhibit-linux-results.md` and list any changes the plan needs.

## Safety rules

- Some checks can really suspend the laptop if the lock is not held. Before any command that
  could suspend, run `systemd-inhibit --list`, confirm `cc-caffeine` is in the list, and ask
  me before you run it.
- Never use `--ignore-inhibitors`, `-i`, or `sudo` for suspend commands.
- Checks marked **HUMAN** need me to act or wait. Tell me exactly what to do, then stop and wait.
- Clean up every background process you start. Finish with `systemd-inhibit --list` and confirm
  no `cc-caffeine` or `verify` entry is left.

## 0. Record the environment

Run and record:

```bash
cat /etc/os-release | head -3
systemctl --version | head -1
test -d /run/systemd/system && echo "booted with systemd"
command -v systemd-inhibit cat
echo "$XDG_CURRENT_DESKTOP / $XDG_SESSION_TYPE"
loginctl show-session "$XDG_SESSION_ID" -p Type -p Class -p Active -p Remote
node --version
```

If `XDG_SESSION_ID` is empty, record that. It matters for check 6.

## Phase A: raw `systemd-inhibit` probes (no cc-caffeine code needed)

Use `--who=verify` for these so they are easy to find and clean up.

### A1. No command lists and exits

Claim: with no command, `systemd-inhibit` lists inhibitors and exits at once. It does not hold.

```bash
timeout 3 systemd-inhibit --what=sleep --who=verify; echo "exit=$?"
```

PASS if it prints a list and exits well before the 3 second timeout (exit is not 124).

### A2. Flags exist

```bash
systemd-inhibit --help
```

Record whether `--what`, `--who`, `--why`, `--mode`, `--list`, and `--no-ask-password` appear.
Confirm `sleep:idle` is accepted:

```bash
systemd-inhibit --what=sleep:idle --who=verify --why=test --mode=block --no-ask-password true; echo "exit=$?"
```

PASS if exit is 0. If `--no-ask-password` is rejected, record the error and retry without it.

### A3. The lock is held while `cat` runs

```bash
systemd-inhibit --what=sleep:idle --who=verify --why=test --mode=block cat < <(sleep 600) &
sleep 1
systemd-inhibit --list | grep -E 'verify|WHO'
```

PASS if a `verify` row shows `sleep:idle` and mode `block`. Keep it running for A4.

### A4. Suspend is refused while the lock is held

Follow the safety rules. Confirm the A3 lock is listed, then ask me before running:

```bash
systemctl suspend --no-ask-password; echo "exit=$?"
```

PASS if it refuses with a message like "Operation inhibited" and the laptop stays on. Then kill
the A3 job and confirm `verify` is gone from the list.

### A5. Killing `systemd-inhibit` also ends `cat` and releases the lock

Claim: the child gets SIGTERM when `systemd-inhibit` dies.

```bash
systemd-inhibit --what=sleep --who=verify --mode=block cat < <(sleep 600) &
sleep 1
INH=$(pgrep -n -x systemd-inhibit); CAT=$(pgrep -P "$INH" -x cat)
echo "inhibit=$INH cat=$CAT"
kill -TERM "$INH"; sleep 1
ps -p "$CAT" >/dev/null && echo "cat STILL RUNNING" || echo "cat gone"
systemd-inhibit --list | grep verify || echo "lock released"
```

PASS if `cat` is gone and the lock is released. Also repeat with `kill -KILL "$INH"`, since
death signals should still fire. Record both.

### A6. A Node crash releases the lock through the stdin pipe

This is the most important check. Claim: when the Node parent dies, even by SIGKILL, the pipe
closes, `cat` exits, `systemd-inhibit` exits, and the lock is released.

Save as `$TMPDIR/hold.js` (or `/tmp/hold.js`):

```js
const { spawn } = require('child_process');
const child = spawn(
  'systemd-inhibit',
  ['--what=sleep:idle', '--who=verify', '--why=node-test', '--mode=block', 'cat'],
  { stdio: ['pipe', 'ignore', 'pipe'] }
);
child.stderr.on('data', d => process.stderr.write(`inhibit stderr: ${d}`));
child.on('error', e => console.error('spawn error:', e.code));
child.on('exit', (code, sig) => console.error('inhibit exit', code, sig));
console.log('node pid', process.pid, 'inhibit pid', child.pid);
setInterval(() => {}, 1000);
if (process.env.RELEASE_AFTER_MS) {
  setTimeout(() => child.kill(), Number(process.env.RELEASE_AFTER_MS));
}
```

```bash
node "$TMPDIR/hold.js" & NODE=$!
sleep 1; systemd-inhibit --list | grep verify
kill -KILL "$NODE"; sleep 1
pgrep -a -x systemd-inhibit; pgrep -a -x cat
systemd-inhibit --list | grep verify || echo "lock released"
```

PASS if no `verify` lock is left and no stray `systemd-inhibit` or `cat` from this test remains.
If this fails, the plan's crash-safety design is wrong. Say so clearly in the results.

Also test the normal release path. Run `RELEASE_AFTER_MS=2000 node "$TMPDIR/hold.js" &`,
check the lock is listed at 1 second, and check it is gone at 4 seconds. Kill the node process
after.

### A7. Missing binary gives a catchable error

```bash
node -e "
const c = require('child_process').spawn('systemd-inhibit-nope', [], { stdio: 'ignore' });
c.on('error', e => console.log('caught', e.code));
"
```

PASS if it prints `caught ENOENT` and does not crash. Then run the same code without the
`on('error')` handler and record that it crashes. This confirms the bug the plan fixes.

### A8. Polkit outside a login session

Claim: `allow_any=auth_admin_keep`, so a process outside any logind session is denied.
`systemd-run --user` starts the process under the user manager, not inside the login session.

```bash
systemd-run --user --wait --pipe -p StandardInput=null \
  systemd-inhibit --what=sleep --who=verify --mode=block --no-ask-password sleep 2; echo "exit=$?"
```

Record the output and exit code. Denied is the expected result. Also try `--what=idle` alone,
which the policy says is allowed everywhere. Record both. If sleep is allowed here too, note
that this machine's polkit rules differ from the upstream defaults
(`ls /etc/polkit-1/rules.d /usr/share/polkit-1/rules.d`).

### A9. Over SSH (HUMAN)

Ask me to SSH into this laptop from another machine (or `ssh localhost` if sshd runs), then run
A3 and `loginctl show-session "$XDG_SESSION_ID" -p Remote -p Active` in that SSH shell.
PASS if the lock is granted. Skip if SSH is not available, and record why.

### A10. Inside tmux

If `tmux` is installed, run A3 inside a new tmux session started from the desktop terminal.
Record whether the lock is granted. tmux servers can outlive or sit outside the session, so
this is a real-world case for Claude Code users.

### A11. Desktop auto-suspend honors the lock (HUMAN)

This is the biggest open question. Electron uses the GNOME session manager, while this plan
uses logind, and they may act differently.

1. Record the current auto-suspend setting so it can be restored.
   GNOME: `gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout`
   and `sleep-inactive-ac-type` (and the `battery` variants). KDE: note the value in
   System Settings > Power Management.
2. Ask me to set auto-suspend on AC and on battery to the shortest value (GNOME: 60 seconds via
   `gsettings set ... 60` and type `'suspend'`).
3. Start the A3 lock. Ask me not to touch the keyboard or mouse for 3 minutes.
4. PASS if the laptop does not suspend. Record whether the screen blanked or locked (expected,
   not a failure).
5. Control run: without the lock, repeat the wait. Confirm it does suspend. If it does not,
   the check proves nothing, so record that.
6. Restore the original settings and confirm them.

Also record what the desktop itself shows while the lock is held:
`gnome-session-inhibit --list` on GNOME, or
`qdbus org.freedesktop.PowerManagement /org/freedesktop/PowerManagement/Inhibit HasInhibit`
on KDE.

### A12. Lid close (HUMAN, optional)

With the A3 lock held, ask me to close the lid for 10 seconds on AC and reopen. Record whether
it suspended. The plan expects it to suspend, since `handle-lid-switch` is out of scope.

## Phase B: end-to-end with cc-caffeine (only if the backend exists)

Check whether the Linux backend is implemented:
`grep -n systemd-inhibit src/native.js`. If there is no match, skip Phase B and say so.

If it exists:

1. Back up `~/.claude/plugins/cc-caffeine/config.json` if present, then set
   `{"sleep_backend": "native", "session_timeout_minutes": 1}`.
2. `npm install && npm test`. Record failures.
3. `echo '{"session_id":"verify-1"}' | node caffeine.js caffeinate`
4. Within 10 seconds: `systemd-inhibit --list | grep cc-caffeine` shows a lock.
   `pgrep -af "caffeine.js server"` shows a plain `node` process, not Electron.
5. `echo '{"session_id":"verify-1"}' | node caffeine.js uncaffeinate`. Within 10 seconds the
   lock is gone.
6. Caffeinate again, then wait past the 1 minute timeout without new hooks. The lock is gone.
7. Caffeinate again, then `kill -KILL` the server PID from `node caffeine.js status`.
   The lock is gone and no `systemd-inhibit` or `cat` is left.
8. Fallback: stop the server. Make a temp dir with symlinks to only `node`, `npm`, and `npx`,
   and run the caffeinate command with `PATH` set to that dir. `systemd-inhibit` is now not
   found. Expect a warning that names the Electron fallback. Electron may fail to start with
   this small `PATH`. That is fine: only the warning and the chosen backend matter here.
9. Failure guard: stop any running server. Make a temp dir with a fake `systemd-inhibit`
   script that prints `Failed to inhibit: Access denied` to stderr and exits 1, and `chmod +x`
   it. Run the server in the foreground with that dir first on `PATH`:
   `PATH="$FAKE:$PATH" node caffeine.js server`. The background server throws away its logs,
   so this must run in the foreground. In another shell, send a caffeinate hook. Expect exactly
   one `Native sleep prevention disabled` line that includes `Access denied`, and no new
   line over the next 30 seconds. Optional: repeat with the real binary under
   `systemd-run --user --pty --working-directory="$PWD" node caffeine.js server` to see a
   real polkit denial, if A8 showed one.
10. Restore the original config and stop the server.

## Results file

Write `docs/systemd-inhibit-linux-results.md` with:

1. The environment block from step 0.
2. A table: check id, PASS/FAIL/SKIP, one-line note.
3. Exact output for every FAIL and for A6, A8, and A11.
4. A short list of changes needed in `docs/systemd-inhibit-plan.md`, or "none".

Do not change product code. Do not commit unless I ask.
