/**
 * System Tray module - Handles the UI (system tray indicator)
 *
 * UI only. The sleep-prevention mechanism lives in backend.js and the
 * decision logic in poller.js. The tray reacts to state changes via the
 * `onStateChange` callback the poller is wired with, so this module never
 * imports the poller (no cycle).
 */

const path = require('path');

const { getElectron } = require('./electron');
const { getConfig } = require('./config');
const { removePidFileWithLock } = require('./pid');
const { disableCaffeine } = require('./backend');
const package = require('../package.json');

let trayState = null;

/**
 * Create icon for system tray
 */
const createIcon = isActive => {
  const { icon_theme } = getConfig();
  const isMono = icon_theme === 'monochrome';
  const suffix = isMono ? '-mono' : '';
  const icon = isActive
    ? `../assets/icon-coffee-full${suffix}.png`
    : `../assets/icon-coffee-empty${suffix}.png`;
  const iconPath = path.join(__dirname, icon);
  const { nativeImage } = getElectron();
  const image = nativeImage.createFromPath(iconPath);
  if (isMono && process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  return image;
};

/**
 * Create system tray
 */
const createSystemTray = () => {
  const { Tray, Menu } = getElectron();

  if (!Tray) {
    throw new Error('Electron Tray is not available');
  }

  try {
    const tray = new Tray(createIcon(false));
    tray.setToolTip('Agentic Insomnia: Normal');

    trayState = {
      tray,
      isCaffeinated: false,
      pollInterval: null,
      powerSaveBlockerId: null
    };

    if (!Menu) {
      throw new Error('Electron Menu is not available');
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `Version: ${package.version}`,
        enabled: false
      },
      {
        label: 'Github',
        click: () => {
          getElectron().shell.openExternal('https://github.com/dakotahp/agentic-insomnia');
        }
      },
      {
        label: '💖 Sponsor',
        click: () => {
          getElectron().shell.openExternal('https://github.com/sponsors/samber');
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Exit',
        click: async () => {
          await shutdownServer(trayState);
          process.exit(0);
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
    return trayState;
  } catch (error) {
    console.error('Error creating Electron system tray:', error);
    throw error;
  }
};

/**
 * Get current system tray state
 */
const getSystemTrayState = () => {
  return trayState;
};

/**
 * Get system tray instance
 */
const getSystemTray = () => {
  if (!trayState) {
    return createSystemTray();
  }
  return trayState;
};

/**
 * Update tray icon based on caffeine state
 */
const updateTrayIcon = state => {
  if (!state || !state.tray) {
    return;
  }

  const icon = createIcon(state.isCaffeinated);
  state.tray.setImage(icon);
  state.tray.setToolTip(`Agentic Insomnia: ${state.isCaffeinated ? 'Caffeinated' : 'Normal'}`);
};

/**
 * Shutdown server and clean up resources
 */
const shutdownServer = async state => {
  console.error('Shutting down caffeine server...');

  if (!state) {
    console.error('No state provided, exiting...');
    return;
  }

  // Stop polling (reference stored on the state by the poller)
  if (state.stopPolling) {
    state.stopPolling();
  }

  // Always disable caffeine before shutting down
  try {
    await disableCaffeine(state);
  } catch (error) {
    console.error('Error disabling caffeine:', error.message);
  }

  // Clean up Electron system tray
  try {
    if (state.tray) {
      state.tray.destroy();
      state.tray = null;
    }
  } catch (error) {
    console.error('Error destroying Electron system tray:', error.message);
  }

  // Remove PID file
  try {
    await removePidFileWithLock();
  } catch (error) {
    console.error('Error removing PID file:', error.message);
  }

  // Reset global state
  trayState = null;
};

module.exports = {
  createIcon,
  createSystemTray,
  getSystemTray,
  getSystemTrayState,
  updateTrayIcon,
  shutdownServer
};
