const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const lockfile = require('proper-lockfile');
const { windowsPowerShellPath } = require('./native');

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'plugins', 'agentic-insomnia');
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

const LOCK_OPTIONS = { retries: 3, stale: 10000 };

const withPidLock = async fn => {
  // proper-lockfile needs the file it locks to exist.
  try {
    const fd = fs.openSync(PID_FILE, 'wx');
    fs.closeSync(fd);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }

  const release = await lockfile.lock(PID_FILE, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
};

const writePidFile = async pid => {
  await fs.promises.writeFile(PID_FILE, pid.toString(), 'utf8');
  await writeHeartbeat(pid);
};

const writeHeartbeat = async pid => {
  await fs.promises.writeFile(HEARTBEAT_FILE, pid.toString(), 'utf8');
};

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
      return null;
    }
    throw error;
  }
};

const removePidFileWithLock = async () => {
  try {
    const release = await lockfile.lock(PID_FILE, LOCK_OPTIONS);

    try {
      await removePidFile();
    } finally {
      await release();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
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

const validatePid = async pid => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    if (error.code === 'ESRCH') {
      return false;
    }
  }

  // Reading a command line on Windows starts PowerShell, which takes about a
  // second, and hooks run this check on every tool call.
  if (deps.platform === 'win32' && (await isHeartbeatFresh(pid))) {
    return true;
  }

  return commandLineIsCaffeineServer(pid);
};

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

const isServerRunningWithLock = () => withPidLock(isServerRunning);

const isServerRunning = async () => {
  try {
    const pid = await readPidFile();

    if (!pid) {
      return false;
    }

    const isValid = await validatePid(pid);

    if (!isValid) {
      await removePidFile();
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error checking if server is running:', error);
    return false;
  }
};

const isStartupInProgress = async () => {
  try {
    const startedAt = parseInt(await fs.promises.readFile(STARTUP_FILE, 'utf8'), 10);

    if (isNaN(startedAt)) {
      return false;
    }

    return Date.now() - startedAt < STARTUP_GRACE_MS;
  } catch {
    return false;
  }
};

const markStartupInProgress = async () => {
  await fs.promises.writeFile(STARTUP_FILE, Date.now().toString(), 'utf8');
};

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
