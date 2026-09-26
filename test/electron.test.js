const { test } = require('node:test');
const assert = require('node:assert');

const loadElectronModule = () => {
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app: { on: () => {} } }
  };
  delete require.cache[require.resolve('../src/electron')];
  return require('../src/electron');
};

test('setupAppEventHandlers leaves SIGINT and SIGTERM to the server shutdown', () => {
  const { setupAppEventHandlers } = loadElectronModule();
  const before = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM')
  };

  setupAppEventHandlers();

  assert.strictEqual(process.listenerCount('SIGINT'), before.SIGINT);
  assert.strictEqual(process.listenerCount('SIGTERM'), before.SIGTERM);
});
