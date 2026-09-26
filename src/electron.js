let electron, Tray, Menu, powerSaveBlocker, nativeImage, app, shell;
let isElectron = false;

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

const isRunningInElectron = () => {
  return !!process.versions.electron;
};

const preventWindowCreation = () => {
  const { app } = getElectron();

  if (app.dock && typeof app.dock.hide === 'function') {
    try {
      app.dock.hide();
    } catch {
      // Hiding the dock icon is cosmetic.
    }
  }

  app.on('browser-window-created', (event, window) => {
    window.hide();
  });
};

const setupAppEventHandlers = () => {
  const { app } = getElectron();

  // Any listener stops Electron's default quit when the last window closes.
  app.on('window-all-closed', () => {});
};

const whenReady = () => {
  const { app } = getElectron();
  return app.whenReady();
};

// Electron turns SIGINT and SIGTERM into an app quit and never calls Node's
// signal listeners, so the server cleans up on will-quit instead.
const onAppQuit = handler => {
  const { app } = getElectron();
  app.once('will-quit', event => {
    event.preventDefault();
    handler();
  });
};

const exitApp = () => {
  getElectron().app.exit(0);
};

module.exports = {
  getElectron,
  isRunningInElectron,
  preventWindowCreation,
  setupAppEventHandlers,
  whenReady,
  onAppQuit,
  exitApp
};
