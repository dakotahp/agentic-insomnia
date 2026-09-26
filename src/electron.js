/**
 * Electron module - Handles all Electron-specific functionality
 */

let electron, Tray, Menu, powerSaveBlocker, nativeImage, app, shell;
let isElectron = false;

/**
 * Load Electron modules only when needed
 */
const loadElectron = () => {
  if (isElectron) {
    return;
  }

  try {
    electron = require('electron');
    Tray = electron.Tray;
    Menu = electron.Menu;
    powerSaveBlocker = electron.powerSaveBlocker;
    nativeImage = electron.nativeImage;
    app = electron.app;
    shell = electron.shell;
    isElectron = true;
  } catch (error) {
    // Don't force-exit: the native backend runs without Electron, so a load
    // failure here must not kill a native server. Let the caller decide.
    console.error('Failed to load Electron:', error.message);
    console.error('Make sure to use Electron: npx electron caffeine.js server');
  }
};

/**
 * Get Electron modules
 */
const getElectron = () => {
  if (!isElectron) {
    loadElectron();
  }
  return {
    electron,
    Tray,
    Menu,
    powerSaveBlocker,
    nativeImage,
    app,
    shell
  };
};

/**
 * Check if running inside Electron
 */
const isRunningInElectron = () => {
  return !!process.versions.electron;
};

/**
 * Prevent any window from being created
 */
const preventWindowCreation = () => {
  const { app } = getElectron();

  if (app.dock && typeof app.dock.hide === 'function') {
    try {
      app.dock.hide();
    } catch {
      // Silently ignore if not macOS or other error
    }
  }

  app.on('browser-window-created', (event, window) => {
    window.hide();
  });
};

/**
 * Setup Electron app event handlers
 */
const setupAppEventHandlers = () => {
  const { app } = getElectron();

  app.on('window-all-closed', () => {
    // Don't quit on window close since we're running in background
  });

  app.on('activate', () => {
    // No window to restore, we're system tray only
  });
};

/**
 * Wait for Electron app to be ready
 */
const whenReady = () => {
  const { app } = getElectron();
  return app.whenReady();
};

/**
 * Quit Electron app
 */
const quit = () => {
  const { app } = getElectron();
  if (app && typeof app.quit === 'function') {
    app.quit();
  } else {
    process.exit(0);
  }
};

module.exports = {
  loadElectron,
  getElectron,
  isRunningInElectron,
  preventWindowCreation,
  setupAppEventHandlers,
  whenReady,
  quit
};
