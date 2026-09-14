#!/usr/bin/env node

/**
 * PID management module - Handles atomic PID file operations and validation
 *
 * This module provides functions to:
 * - Atomically read/write PID files
 * - Validate if a PID belongs to a caffeine server process
 * - Clean up stale PID files
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const lockfile = require('proper-lockfile');
const { windowsPowerShellPath } = require('./native');

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cc-caffeine');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');
const STARTUP_FILE = path.join(CONFIG_DIR, 'server.starting');
const HEARTBEAT_FILE = path.join(CONFIG_DIR, 'server.heartbeat');

// A server only writes its PID once Electron has booted, which takes seconds.
// Long enough to cover that window, short enough to retry a failed startup.
const STARTUP_GRACE_MS = 30 * 1000;

// Polls refresh the heartbeat every 5 seconds, but an Electron server writes its
// PID before Electron is ready and polling starts.
const HEARTBEAT_STALE_MS = 30 * 1000;

let deps = {
  platform: os.platform(),
  now: Date.now
};

const setDependencies = overrides => {
  deps = { ...deps, ...overrides };
};

const withPidLock = async fn => {
  // create if not exists
  try {
    const fd = fs.openSync(PID_FILE, 'wx');
    fs.closeSync(fd);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
    // If EEXIST, file already exists, nothing to do
  }

  let output = null;

  const release = await lockfile.lock(PID_FILE, {
    retries: 3,
    stale: 10000 // 10 seconds
  });
  try {
    output = await fn();
  } finally {
    await release();
  }

  return output;
};

/**
 * Write PID to file
 * @param {number} pid - Process ID to write
 */
const writePidFile = async pid => {
  try {
    await fs.promises.writeFile(PID_FILE, pid.toString(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, create it without locking
      await fs.promises.writeFile(PID_FILE, pid.toString(), 'utf8');
    } else {
      throw error;
    }
  }
  await writeHeartbeat(pid);
};

/**
 * Record that the server with this PID is alive
 * @param {number} pid - Process ID of the server
 */
const writeHeartbeat = async pid => {
  await fs.promises.writeFile(HEARTBEAT_FILE, pid.toString(), 'utf8');
};

/**
 * Check whether the server with this PID refreshed its heartbeat recently
 * @param {number} pid - Process ID named in the PID file
 * @returns {Promise<boolean>}
 */
const isHeartbeatFresh = async pid => {
  try {
    const [content, stats] = await Promise.all([
      fs.promises.readFile(HEARTBEAT_FILE, 'utf8'),
      fs.promises.stat(HEARTBEAT_FILE)
    ]);
    return (
      parseInt(content.trim(), 10) === pid && deps.now() - stats.mtimeMs < HEARTBEAT_STALE_MS
    );
  } catch {
    return false;
  }
};

/**
 * Read PID from file
 * @returns {number|null} PID if found and valid, null otherwise
 */
const readPidFile = async () => {
  try {
    const pidStr = await fs.promises.readFile(PID_FILE, 'utf8');
    const pid = parseInt(pidStr.trim(), 10);

    if (isNaN(pid) || pid <= 0) {
      return null;
    }

    return pid;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    throw error;
  }
};

/**
 * Remove PID file
 */
const removePidFileWithLock = async () => {
  try {
    const release = await lockfile.lock(PID_FILE, {
      retries: 3,
      stale: 10000 // 10 seconds
    });

    try {
      await removePidFile();
    } finally {
      await release();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File already doesn't exist, that's fine
      return;
    }
    throw error;
  }
};

const removePidFile = async () => {
  const pid = await readPidFile();
  if (pid === process.pid) {
    await fs.promises.unlink(PID_FILE);
    await fs.promises.rm(HEARTBEAT_FILE, { force: true });
  }
};

/**
 * Build the command that prints a process's full command line
 * @param {number} pid - Process ID to inspect
 * @param {string} platform - Value of os.platform()
 * @returns {{cmd: string, args: string[]}}
 */
const commandLineQuery = (pid, platform) => {
  const safePid = String(Math.trunc(Number(pid)));

  if (platform === 'win32') {
    // wmic is removed from current Windows 11 releases, so query WMI through the
    // PowerShell that ships with Windows. The absolute path avoids PATH lookups.
    return {
      cmd: windowsPowerShellPath(),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${safePid}').CommandLine`
      ]
    };
  }

  // -ww disables ps's column truncation. Without it the command line is cut
  // at the terminal width, and long install paths (npx cache dirs are well
  // over 80 characters) lose the "caffeine.js server" suffix matched below.
  return { cmd: 'ps', args: ['-ww', '-p', safePid, '-o', 'command='] };
};

/**
 * Check if a process with given PID exists and is a caffeine server
 * @param {number} pid - Process ID to check
 * @returns {Promise<boolean>} True if process exists and is caffeine server
 */
const validatePid = async pid => {
  try {
    process.kill(pid, 0); // Signal 0 just checks if process exists
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    // Other errors (like EPERM) mean process exists but we can't signal it
  }

  // Reading a command line on Windows starts PowerShell, which takes about a
  // second, and hooks run this check on every tool call.
  if (deps.platform === 'win32' && (await isHeartbeatFresh(pid))) {
    return true;
  }

  return commandLineIsCaffeineServer(pid);
};

/**
 * Check whether a running process's command line is a caffeine server
 * @param {number} pid - Process ID to inspect
 * @returns {Promise<boolean>}
 */
const commandLineIsCaffeineServer = pid => {
  return new Promise(resolve => {
    const { cmd, args } = commandLineQuery(pid, deps.platform);
    const psCommand = spawn(cmd, args, { stdio: 'pipe', windowsHide: true });

    let output = '';

    psCommand.stdout.on('data', data => {
      output += data.toString();
    });

    psCommand.on('close', code => {
      if (code !== 0) {
        resolve(false);
        return;
      }

      const commandLine = output.trim().toLowerCase();
      for (const line of commandLine.split('\n')) {
        // Check if command line contains both "caffeine" and "server"
        const isCaffeineServer =
          line.includes('caffeine server') || line.includes('caffeine.js server');
        const isElectron = line.includes('electron');
        const isNative = line.includes('node') && !isElectron;

        if (isCaffeineServer && (isElectron || isNative)) {
          resolve(true);
          return;
        }
      }

      resolve(false);
    });

    psCommand.on('error', () => {
      resolve(false);
    });
  });
};

/**
 * Check if caffeine server is running using PID file
 * @returns {Promise<boolean>} True if server is running
 */
const isServerRunningWithLock = async () => {
  return await withPidLock(async () => {
    return await isServerRunning();
  });
};

/**
 * Check if caffeine server is running using PID file
 * @returns {Promise<boolean>} True if server is running
 */
const isServerRunning = async () => {
  try {
    const pid = await readPidFile();

    if (!pid) {
      return false;
    }

    const isValid = await validatePid(pid);

    if (!isValid) {
      // PID is stale, clean it up
      await removePidFile();
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error checking if server is running:', error);
    return false;
  }
};

/**
 * Check whether a server startup was initiated recently enough that the server
 * may not have written its PID file yet
 * @returns {Promise<boolean>} True if a startup is still within the grace window
 */
const isStartupInProgress = async () => {
  try {
    const startedAt = parseInt(await fs.promises.readFile(STARTUP_FILE, 'utf8'), 10);

    if (isNaN(startedAt)) {
      return false;
    }

    return Date.now() - startedAt < STARTUP_GRACE_MS;
  } catch {
    return false; // No marker, or unreadable - treat as no startup underway
  }
};

/**
 * Record that a server startup is being initiated now
 */
const markStartupInProgress = async () => {
  await fs.promises.writeFile(STARTUP_FILE, Date.now().toString(), 'utf8');
};

/**
 * Check whether the PID file names a process other than the caller
 * @param {number} ownPid - PID of the calling server
 * @returns {Promise<boolean>} True only when the file holds a different valid PID
 */
const isPidFileOwnedByOther = async ownPid => {
  const pid = await readPidFile();
  return pid !== null && pid !== ownPid;
};

module.exports = {
  writePidFile,
  readPidFile,
  removePidFileWithLock,
  removePidFile,
  isPidFileOwnedByOther,
  writeHeartbeat,
  isHeartbeatFresh,
  commandLineQuery,
  validatePid,
  setDependencies,
  HEARTBEAT_STALE_MS,
  isServerRunningWithLock,
  isServerRunning,
  isStartupInProgress,
  markStartupInProgress,
  withPidLock
};
