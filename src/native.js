/**
 * Native backend - Prevents sleep with the OS sleep tool, without Electron.
 *
 * macOS runs `caffeinate`. Linux runs `systemd-inhibit`, which holds a logind
 * sleep lock for as long as its child command runs. The child process is stored
 * on the state object and killed on disable/shutdown.
 *
 * Dependencies are injectable (`setDependencies`) so the backend can be tested
 * on any OS without spawning real processes.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EARLY_EXIT_MS = 2000;

const commandOnPath = name =>
  (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some(dir => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

let deps = {
  spawn,
  platform: process.platform,
  commandExists: commandOnPath,
  isSystemdBooted: () => fs.existsSync('/run/systemd/system'),
  now: Date.now
};

const setDependencies = overrides => {
  deps = { ...deps, ...overrides };
};

const resolveNativeCommand = platform => {
  if (platform === 'darwin') {
    return { cmd: 'caffeinate', args: ['-i'], stdio: 'ignore' };
  }

  if (platform === 'linux') {
    // `cat` holds the lock until its stdin pipe closes. The pipe also closes when
    // this process dies, so a crashed server cannot leave the lock behind.
    return {
      cmd: 'systemd-inhibit',
      args: [
        '--what=sleep:idle',
        '--who=cc-caffeine',
        '--why=Claude Code session active',
        '--mode=block',
        'cat'
      ],
      stdio: ['pipe', 'ignore', 'pipe']
    };
  }

  return null;
};

const isAvailable = () => {
  if (deps.platform === 'darwin') {
    return deps.commandExists('caffeinate');
  }

  if (deps.platform === 'linux') {
    return deps.isSystemdBooted() && deps.commandExists('systemd-inhibit');
  }

  return false;
};

const recordFailure = (state, reason) => {
  if (state.nativeFailure) {
    return;
  }

  state.nativeFailure = reason;
  console.error(`Native sleep prevention disabled: ${reason}`);
};

/**
 * Enable caffeine (prevent sleep) by spawning the platform's sleep tool.
 *
 * A tool that fails to start or exits within EARLY_EXIT_MS is recorded on
 * `state.nativeFailure`, and later calls do nothing, so the poller does not
 * respawn a failing process on every tick.
 * @param {object} state - Tray state object with isCaffeinated / caffeinateProcess
 */
const enableCaffeine = state => {
  if (state.isCaffeinated || state.nativeFailure) {
    return;
  }

  const command = resolveNativeCommand(deps.platform);
  if (!command) {
    recordFailure(state, `no native sleep tool for platform ${deps.platform}`);
    return;
  }

  const child = deps.spawn(command.cmd, command.args, { stdio: command.stdio });
  const startedAt = deps.now();
  let stderr = '';

  if (child.stderr) {
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
  }

  const release = () => {
    if (state.caffeinateProcess !== child) {
      return false;
    }
    state.caffeinateProcess = null;
    state.isCaffeinated = false;
    return true;
  };

  child.on('error', error => {
    release();
    recordFailure(state, `${command.cmd} failed to start: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (!release()) {
      return;
    }

    if (deps.now() - startedAt < EARLY_EXIT_MS) {
      const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
      recordFailure(
        state,
        `${command.cmd} exited early (code ${code}, signal ${signal})${detail}`
      );
    }
  });

  state.caffeinateProcess = child;
  state.isCaffeinated = true;
};

/**
 * Disable caffeine (allow sleep) by killing the sleep tool child.
 * @param {object} state - Tray state object with isCaffeinated / caffeinateProcess
 */
const disableCaffeine = state => {
  if (!state.isCaffeinated || !state.caffeinateProcess) {
    return;
  }

  const child = state.caffeinateProcess;
  state.caffeinateProcess = null;
  state.isCaffeinated = false;
  child.kill();
};

module.exports = {
  enableCaffeine,
  disableCaffeine,
  isAvailable,
  resolveNativeCommand,
  setDependencies,
  EARLY_EXIT_MS
};
