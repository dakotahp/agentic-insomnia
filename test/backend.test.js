const { test } = require('node:test');
const assert = require('node:assert');

const loadBackend = () => {
  const configPath = require.resolve('../src/config');
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { getConfig: () => ({ sleep_backend: 'electron' }) }
  };
  delete require.cache[require.resolve('../src/backend')];
  return require('../src/backend');
};

const makeState = () => ({
  isCaffeinated: false,
  powerSaveBlockerId: null
});

const mockPowerSaveBlocker = () => {
  const calls = { start: [], stop: [] };
  const powerSaveBlocker = {
    start: reason => {
      calls.start.push(reason);
      return 1;
    },
    stop: id => {
      calls.stop.push(id);
      return true;
    }
  };
  return { powerSaveBlocker, calls };
};

const installMock = () => {
  const { powerSaveBlocker, calls } = mockPowerSaveBlocker();
  const electronPath = require.resolve('../src/electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { getElectron: () => ({ powerSaveBlocker }) }
  };
  return calls;
};

test('enableCaffeine toggles state and starts the blocker', () => {
  const calls = installMock();
  const { enableCaffeine } = loadBackend();
  const state = makeState();

  enableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, true);
  assert.strictEqual(state.powerSaveBlockerId, 1);
  assert.deepStrictEqual(calls.start, ['prevent-app-suspension']);
});

test('enableCaffeine is idempotent when already caffeinated', () => {
  const calls = installMock();
  const { enableCaffeine } = loadBackend();
  const state = makeState();
  state.isCaffeinated = true;
  state.powerSaveBlockerId = 1;

  enableCaffeine(state);

  assert.strictEqual(calls.start.length, 0);
});

test('disableCaffeine toggles state and stops the blocker', () => {
  const calls = installMock();
  const { disableCaffeine } = loadBackend();
  const state = makeState();
  state.isCaffeinated = true;
  state.powerSaveBlockerId = 1;

  disableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, false);
  assert.strictEqual(state.powerSaveBlockerId, null);
  assert.deepStrictEqual(calls.stop, [1]);
});

test('disableCaffeine is a no-op when not caffeinated', () => {
  const calls = installMock();
  const { disableCaffeine } = loadBackend();
  const state = makeState();

  disableCaffeine(state);

  assert.strictEqual(calls.stop.length, 0);
});
