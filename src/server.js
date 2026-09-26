const path = require('path');
const { spawn } = require('child_process');

const { initSessionsFile } = require('./session');
const { createSystemTray, updateTrayIcon, shutdownServer } = require('./system-tray');
const { startPolling } = require('./poller');
const {
  isRunningInElectron,
  preventWindowCreation,
  setupAppEventHandlers,
  whenReady,
  quit
} = require('./electron');
const {
  isServerRunning,
  writePidFile,
  withPidLock,
  isStartupInProgress,
  markStartupInProgress
} = require('./pid');
const { getSleepBackend } = require('./backend');
const { writeExampleConfig } = require('./config');

const CHECK_INTERVAL = 5 * 1000;

const runServerProcessIfNotStarted = async () => {
  let mustStart = false;

  try {
    // Claim the startup inside the lock so concurrent hooks agree on which one
    // of them spawns the server. The spawn itself happens after the lock is
    // released, because the spawned process needs the lock to write its PID.
    await withPidLock(async () => {
      if (await isServerRunning()) {
        console.error('Server is already running');
        return;
      }

      if (await isStartupInProgress()) {
        console.error('Server startup is already in progress');
        return;
      }

      await markStartupInProgress();
      mustStart = true;
    });
  } catch (error) {
    if (error.code === 'ELOCKED') {
      // Another process holds the lock and will decide whether to start.
      console.error('Server startup is being handled by another process');
      return;
    }
    throw error;
  }

  if (mustStart) {
    console.error('Server not running, starting...');
    await startServerProcess();
  }
};

const serverSpawnOptions = platform => ({
  detached: true,
  stdio: 'ignore',
  // On Windows npm is npm.cmd, which Node only runs through a shell. The
  // arguments are fixed strings, so the shell cannot inject anything.
  shell: platform === 'win32',
  windowsHide: true
});

const startServerProcess = async () => {
  console.error('Starting caffeine server...');

  const cwd = path.join(__dirname, '..');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const script = getSleepBackend() === 'native' ? 'native-server' : 'server';

  const serverProcess = spawn('npm', ['run', script], {
    ...serverSpawnOptions(process.platform),
    cwd,
    env
  });

  serverProcess.unref();

  await new Promise(resolve => setTimeout(resolve, 500));
};

const handleServer = async () => {
  let mustStartHere = false;
  let mustSpawnElectron = false;

  await withPidLock(async () => {
    if (await isServerRunning()) {
      console.error('Caffeine server is already running');
      return;
    }

    if (isRunningInElectron() || getSleepBackend() === 'native') {
      mustStartHere = true;
      await writePidFile(process.pid);
    } else {
      mustSpawnElectron = true;
      console.error('Not running inside Electron, spawning Electron process...');
    }
  });

  if (mustStartHere) {
    await startServer();
  } else if (mustSpawnElectron) {
    spawnElectronProcess();
  } else if (isRunningInElectron()) {
    process.exit(0);
  }
};

const createState = () => ({
  isCaffeinated: false,
  powerSaveBlockerId: null,
  caffeinateProcess: null,
  tray: null
});

const runServer = async (state, onStateChange, exit) => {
  await initSessionsFile();

  const shutDown = async () => {
    await shutdownServer(state);
    exit();
  };

  startPolling(state, CHECK_INTERVAL, onStateChange, shutDown, shutDown);
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);
};

const startServer = async () => {
  writeExampleConfig();
  const state = createState();

  try {
    if (getSleepBackend() === 'native') {
      await runServer(state, undefined, () => process.exit(0));
      console.error('Native caffeine server started');
      return;
    }

    preventWindowCreation();
    setupAppEventHandlers();
    await whenReady();

    // The tray is UI only, so the server still runs headless without it.
    let onStateChange;
    try {
      createSystemTray(state);
      onStateChange = updateTrayIcon;
    } catch (trayError) {
      console.error('System tray unavailable, running headless:', trayError.message);
    }

    await runServer(state, onStateChange, quit);
    console.error('Electron caffeine server started');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

const spawnElectronProcess = () => {
  const cwd = path.join(__dirname, '..');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronProcess = spawn('npx', ['electron', 'caffeine.js', 'server'], {
    stdio: 'inherit',
    shell: true,
    detached: false,
    cwd,
    env
  });

  electronProcess.on('exit', code => {
    process.exit(code || 0);
  });

  electronProcess.on('error', error => {
    console.error('Failed to spawn Electron process:', error);
    process.exit(1);
  });

  electronProcess.on('close', code => {
    process.exit(code || 0);
  });
};

module.exports = {
  handleServer,
  runServerProcessIfNotStarted,
  serverSpawnOptions
};
