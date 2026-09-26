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
  onAppQuit,
  exitApp
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
const APP_DIR = path.join(__dirname, '..');
const CAFFEINE_JS = path.join(APP_DIR, 'caffeine.js');

// Electron downloads its binary the first time anything asks for its path.
// Its cli.js does that in the spawned process, so a hook never waits for it.
const serverCommand = () => ({
  cmd: process.execPath,
  args:
    getSleepBackend() === 'native'
      ? [CAFFEINE_JS, 'server']
      : [require.resolve('electron/cli.js'), CAFFEINE_JS, 'server']
});

const serverEnv = () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

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
    startServerProcess();
  }
};

const startServerProcess = () => {
  const { cmd, args } = serverCommand();
  const serverProcess = spawn(cmd, args, {
    cwd: APP_DIR,
    env: serverEnv(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });

  serverProcess.on('error', error => {
    console.error('Failed to start the caffeine server:', error.message);
  });
  serverProcess.unref();
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
  return shutDown;
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

    onAppQuit(await runServer(state, onStateChange, exitApp));
    console.error('Electron caffeine server started');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

const spawnElectronProcess = () => {
  const { cmd, args } = serverCommand();
  const electronProcess = spawn(cmd, args, { cwd: APP_DIR, env: serverEnv(), stdio: 'inherit' });

  electronProcess.on('error', error => {
    console.error('Failed to spawn Electron process:', error);
    process.exit(1);
  });

  electronProcess.on('exit', code => {
    process.exit(code || 0);
  });
};

module.exports = {
  handleServer,
  runServerProcessIfNotStarted,
  serverCommand
};
