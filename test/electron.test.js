const { test } = require('node:test');
const assert = require('node:assert');

const loadElectronModule = (app = { on: () => {} }) => {
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app }
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

test('onAppQuit holds the quit until the handler runs, once', () => {
  const listeners = {};
  const app = {
    on: () => {},
    once: (event, listener) => {
      listeners[event] = listener;
    }
  };
  const { onAppQuit } = loadElectronModule(app);
  let calls = 0;
  let prevented = false;

  onAppQuit(() => {
    calls++;
  });
  listeners['will-quit']({ preventDefault: () => (prevented = true) });

  assert.strictEqual(prevented, true);
  assert.strictEqual(calls, 1);
});
