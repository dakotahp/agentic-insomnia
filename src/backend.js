/**
 * Backend module - Handles the sleep-prevention mechanism
 *
 * This is the swappable seam: it dispatches to one of two backends based on
 * the `sleep_backend` config setting:
 *   - 'electron' (default): Electron's powerSaveBlocker
 *   - 'native':     the OS sleep tool via src/native.js (`caffeinate` on macOS,
 *                   `systemd-inhibit` on Linux), or 'electron' when no tool exists
 *
 * The decision (poller) and UI (system-tray) layers stay backend-agnostic.
 */

const { getElectron } = require('./electron');
const { getConfig } = require('./config');
const native = require('./native');

let resolvedBackend = null;

/**
 * The backend this process uses. The result is cached so the server script
 * choice and the mechanism always agree for the life of the process.
 * @returns {'electron' | 'native'}
 */
const getSleepBackend = () => {
  if (resolvedBackend) {
    return resolvedBackend;
  }

  if (getConfig().sleep_backend !== 'native') {
    resolvedBackend = 'electron';
  } else if (native.isAvailable()) {
    resolvedBackend = 'native';
  } else {
    console.error(
      'Warning: sleep_backend "native" is not available on this system, using "electron"'
    );
    resolvedBackend = 'electron';
  }

  return resolvedBackend;
};

/**
 * Enable caffeine (prevent sleep)
 * @param {object} state - Tray state object
 */
const enableCaffeine = state => {
  if (getSleepBackend() === 'native') {
    native.enableCaffeine(state);
    return;
  }

  if (!state.isCaffeinated) {
    const { powerSaveBlocker } = getElectron();
    state.isCaffeinated = true;
    state.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
};

/**
 * Disable caffeine (allow sleep)
 * @param {object} state - Tray state object
 */
const disableCaffeine = state => {
  if (getSleepBackend() === 'native') {
    native.disableCaffeine(state);
    return;
  }

  if (state.isCaffeinated) {
    const { powerSaveBlocker } = getElectron();
    state.isCaffeinated = false;
    if (state.powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(state.powerSaveBlockerId);
      state.powerSaveBlockerId = null;
    }
  }
};

module.exports = {
  getSleepBackend,
  enableCaffeine,
  disableCaffeine
};
