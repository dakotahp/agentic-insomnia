const path = require('path');

const { getElectron } = require('./electron');
const { getConfig } = require('./config');
const { removePidFileWithLock } = require('./pid');
const { disableCaffeine } = require('./backend');
const package = require('../package.json');

const createIcon = isActive => {
  const { tray_icon_theme } = getConfig();
  const isMono = tray_icon_theme === 'monochrome';
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

const createSystemTray = state => {
  const { Tray, Menu } = getElectron();

  if (!Tray || !Menu) {
    throw new Error('Electron Tray is not available');
  }

  const tray = new Tray(createIcon(false));
  tray.setToolTip('Agentic Insomnia: Normal');
  tray.setContextMenu(
    Menu.buildFromTemplate([
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
        type: 'separator'
      },
      {
        label: 'Exit',
        click: async () => {
          await shutdownServer(state);
          process.exit(0);
        }
      }
    ])
  );

  state.tray = tray;
};

const updateTrayIcon = state => {
  if (!state || !state.tray) {
    return;
  }

  const icon = createIcon(state.isCaffeinated);
  state.tray.setImage(icon);
  state.tray.setToolTip(`Agentic Insomnia: ${state.isCaffeinated ? 'Caffeinated' : 'Normal'}`);
};

const shutdownServer = async state => {
  console.error('Shutting down caffeine server...');

  if (state.stopPolling) {
    state.stopPolling();
  }

  try {
    await disableCaffeine(state);
  } catch (error) {
    console.error('Error disabling caffeine:', error.message);
  }

  try {
    if (state.tray) {
      state.tray.destroy();
      state.tray = null;
    }
  } catch (error) {
    console.error('Error destroying Electron system tray:', error.message);
  }

  try {
    await removePidFileWithLock();
  } catch (error) {
    console.error('Error removing PID file:', error.message);
  }
};

module.exports = {
  createSystemTray,
  updateTrayIcon,
  shutdownServer
};
