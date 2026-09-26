/**
 * Server module - Handles server process management and startup
 */

const path = require('path');
const { spawn } = require('child_process');

const { initSessionsFile } = require('./session');
const { getSystemTray, updateTrayIcon, shutdownServer } = require('./system-tray');
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

const CHECK_INTERVAL = 5 * 1000; // 5 seconds

/**
 * Ensure server is running, start if needed
 */
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

/**
 * Spawn options for the detached `npm run` that starts the server
 * @param {string} platform - Value of process.platform
 */
const serverSpawnOptions = platform => ({
  detached: true,
  stdio: 'ignore',
  // On Windows npm is npm.cmd, which Node only runs through a shell. The
  // arguments are fixed strings, so the shell cannot inject anything.
  shell: platform === 'win32',
  windowsHide: true
});

/**
 * Start server process using npm
 */
const startServerProcess = async () => {
  console.error('Starting caffeine server...');

  const cwd = path.join(__dirname, '..');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // The native backend runs as a plain Node process, no Electron.
  const script = getSleepBackend() === 'native' ? 'native-server' : 'server';

  const serverProcess = spawn('npm', ['run', script], {
    ...serverSpawnOptions(process.platform),
    cwd, // is needed to find the correct caffeine.js
    env
  });

  serverProcess.unref();

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 500));

  return true;
};

/**
 * Handle server command - start Electron server or delegate with atomic file locking
 */
const handleServer = async () => {
  let mustStartServer = false;
  let mustStartElectron = false;
  let mustStartNative = false;

  await withPidLock(async () => {
    try {
      // Inside the lock, check if server is already running
      const alreadyRunning = await isServerRunning();
      if (alreadyRunning) {
        console.error('Caffeine server is already running');
        return;
      }

      if (isRunningInElectron()) {
        mustStartServer = true;
        console.error('Already running inside Electron, starting server...');
        await writePidFile(process.pid);
      } else if (getSleepBackend() === 'native') {
        mustStartNative = true;
        console.error('Native backend, starting server in this process...');
        await writePidFile(process.pid);
      } else {
        mustStartElectron = true;
        console.error('Not running inside Electron, spawning Electron process...');
      }
    } catch (error) {
      if (error.code === 'ELOCKED' || error.code === 'EEXIST') {
        // Another process has the lock, server is likely starting up
        console.error('Server startup is in progress by another process');
      } else {
        console.error('Failed to acquire server startup lock:', error);
        throw error;
      }
    }
  });

  if (mustStartNative) {
    await startServer();
  } else if (mustStartElectron) {
    await spawnElectronProcess();
  } else if (mustStartServer) {
    await startServer();
  } else if (isRunningInElectron()) {
    await shutdownServer();
    process.exit(0);
  }
};

/**
 * Build the callback a server runs when another server has taken over the PID file
 * @param {() => void} exit - How this kind of server exits
 */
const shutDownWhenSuperseded = exit => async state => {
  await shutdownServer(state);
  exit();
};

/**
 * Start the server. With the native backend this runs as a plain Node process
 * (no Electron); with the Electron backend it boots the headless tray app.
 */
const startServer = async () => {
  writeExampleConfig();

  if (getSleepBackend() === 'native') {
    return startNativeServer();
  }

  console.error('Loading Electron...');

  // Prevent any window from being created
  preventWindowCreation();

  setupAppEventHandlers();

  // Wait for app to be ready before starting system tray
  await whenReady();

  // Start the actual server
  try {
    await initSessionsFile();

    // The system tray is UI only. When Electron is unavailable it may fail;
    // the server still runs headless.
    let state;
    let onStateChange;
    try {
      state = getSystemTray();
      onStateChange = updateTrayIcon;
      console.error('Caffeine server started successfully with system tray');
    } catch (trayError) {
      console.error('System tray unavailable, running headless:', trayError.message);
      state = { isCaffeinated: false, powerSaveBlockerId: null, caffeinateProcess: null };
      onStateChange = undefined;
    }

    const shutDown = shutDownWhenSuperseded(quit);
    startPolling(state, CHECK_INTERVAL, onStateChange, shutDown, shutDown);

    // Only setup signal handlers if server actually started
    if (state) {
      // Handle process termination for Electron process
      process.on('SIGINT', async () => {
        console.error('Received SIGINT, shutting down server...');
        await shutdownServer(state);
        quit();
      });

      process.on('SIGTERM', async () => {
        console.error('Received SIGTERM, shutting down server...');
        await shutdownServer(state);
        quit();
      });
    }

    return state;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

/**
 * Start the server as a plain Node process (native backend, no Electron).
 */
const startNativeServer = async () => {
  console.error('Starting native caffeine server...');

  try {
    await initSessionsFile();

    const state = {
      isCaffeinated: false,
      powerSaveBlockerId: null,
      caffeinateProcess: null
    };

    const shutDown = shutDownWhenSuperseded(() => process.exit(0));
    startPolling(state, CHECK_INTERVAL, undefined, shutDown, shutDown);

    process.on('SIGINT', async () => {
      console.error('Received SIGINT, shutting down server...');
      await shutdownServer(state);
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.error('Received SIGTERM, shutting down server...');
      await shutdownServer(state);
      process.exit(0);
    });

    console.error('Native caffeine server started successfully');
    return state;
  } catch (error) {
    console.error('Failed to start native server:', error);
    process.exit(1);
  }
};

/**
 * Spawn new Electron process for server
 */
const spawnElectronProcess = () => {
  const cwd = path.join(__dirname, '..');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronProcess = spawn('npx', ['electron', 'caffeine.js', 'server'], {
    stdio: 'inherit',
    shell: true,
    detached: false,
    cwd, // is needed to find caffeine.js
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

  return electronProcess.pid;
};

module.exports = {
  handleServer,
  runServerProcessIfNotStarted,
  serverSpawnOptions
};
