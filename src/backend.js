const { getElectron } = require('./electron');
const { getConfig } = require('./config');
const native = require('./native');

let resolvedBackend = null;

// Cached so the server script a client spawns and the mechanism that server
// uses always agree for the life of the process.
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
