# Prompt: Final Phase of the Linux `systemd-inhibit` Backend

Paste everything below the line into a Claude Code session on the Linux laptop, started from
the cc-caffeine repo root. It is written for a session with no prior context.

---

You are finishing a feature that was built on macOS and never run on Linux. Your job is to
validate it on this real Linux machine, fix what the validation finds, and leave the branch
ready for review.

## Context

Branch: `worktree-systemd-inhibit-plan`. Version 0.6.0.

Done on macOS, with unit tests passing on every platform:

- `src/native.js` runs `systemd-inhibit --what=sleep:idle --who=cc-caffeine --why=... --mode=block cat`
  on Linux, with a stdin pipe. `isAvailable()` checks `/run/systemd/system` and `PATH`.
  A tool that fails or exits within 2 seconds is recorded on `state.nativeFailure` and not
  respawned.
- `src/backend.js` has `getSleepBackend()`, which falls back to Electron with a warning when
  native is unavailable. `src/server.js` uses it to pick the server script.
- `status` prints the sleep backend.
- README, `AGENTS.md`, `ARCHITECTURE.md`, and `CHANGELOG.md` describe Linux support as new and
  still being validated.

Read these first: `docs/systemd-inhibit-plan.md` (design and concessions),
`docs/systemd-inhibit-linux-verification-prompt.md` (the checks), `src/native.js`,
`src/backend.js`.

Not proven yet: everything that needs a real Linux machine. The biggest open questions are:

1. Does a SIGKILLed server really release the lock through the stdin pipe? (check A6)
2. Does desktop auto-suspend respect the logind lock? (check A11)
3. Is `--no-ask-password` supported, and is it needed? (checks A2 and A8)

## Step 1: set up and run the tests

```bash
git fetch origin && git checkout worktree-systemd-inhibit-plan && git pull
npm install
npm test
npm run lint
```

Record the results. Fix any failure that is specific to Linux before moving on.

## Step 2: run the checks

Work through all of `docs/systemd-inhibit-linux-verification-prompt.md`: step 0, Phase A, and
Phase B. Phase B applies, since the backend exists on this branch. Follow its safety rules
exactly, and stop for me on every HUMAN step.

Write the results to `docs/systemd-inhibit-linux-results.md` as that doc describes.

## Step 3: decide and fix

Apply these rules to the results. For each change, write a failing test first when the
behavior can be unit tested, then the fix. Keep changes small.

- **A6 fails** (the lock survives a SIGKILLed Node parent): the crash-safety design is wrong.
  Replace `cat` with `tail --pid=<server pid> -f /dev/null`, passing `process.pid`, which exits
  when the server process dies. Re-run A6 with that command to prove it before changing code.
  Update the comment in `resolveNativeCommand` and the Linux sections of `ARCHITECTURE.md` and
  `AGENTS.md`.
- **A5 shows `cat` surviving** after `systemd-inhibit` is killed: add a cleanup that kills the
  child's process group, or use the `tail --pid` command above. Prove it with A5 first.
- **A2 shows `--no-ask-password` is supported, and A8 or B9 shows a hang or a password
  prompt**: add the flag to the Linux args and to the unit test. If there was no hang or
  prompt, leave it out, since older systemd versions may reject it.
- **A11 fails** (the desktop suspends while the lock is held): do not change code yet. Test
  whether also holding a desktop-level lock fixes it. On GNOME, try
  `systemd-inhibit ... gnome-session-inhibit --inhibit suspend:idle --reason test cat`, and
  confirm the stdin pipe still reaches `cat` (repeat A6 with that command). Report what works,
  and ask me before building it in.
- **A8 shows sleep locks allowed outside a session**: soften the polkit note in the README
  Linux notes and in `ARCHITECTURE.md` to "may be denied, depending on the distro's polkit
  rules".
- **A12 shows lid close does not suspend** while the lock is held: remove the lid-close bullet
  from the README and `ARCHITECTURE.md`.
- **B8 or B9 fails**: fix `getSleepBackend()` or the failure guard in `native.js` so they match
  the documented behavior.
- **Anything else unexpected**: record it and ask me before changing the design.

## Step 4: update the docs to match what was proven

- README "Linux notes": replace "testing on real Linux desktops is still in progress" with the
  distro, systemd version, and desktop you tested on. Keep every limit that is still true.
- `ARCHITECTURE.md` and `AGENTS.md`: same update, and reflect any design change from step 3.
- `CHANGELOG.md` 0.6.0: remove "validation on real Linux desktops is still in progress", and
  add any fix from step 3. Keep the version at 0.6.0, since it has not shipped.
- `docs/systemd-inhibit-plan.md`: set its status line to "validated" or list what is still
  open.

## Step 5: commit and push

Follow the repo's pre-commit rules: tests for changed files pass, lint is clean. Commit fixes
and doc updates as separate commits with clear messages. Push the branch.

Do not merge, and do not remove the `docs/` files. I remove them before merging.

## Report back

End with:

1. The environment you tested on.
2. A PASS/FAIL line for A6, A11, A8, and Phase B.
3. One line per code or doc change, naming the file.
4. Anything still open, and what you need from me.
