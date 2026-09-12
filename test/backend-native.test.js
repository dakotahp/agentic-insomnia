const { test } = require('node:test');
const assert = require('node:assert');

const loadBackend = () => {
  delete require.cache[require.resolve('../src/backend')];
  return require('../src/backend');
};

const loadBoth = ({ available = true } = {}) => {
  delete require.cache[require.resolve('../src/backend')];
  delete require.cache[require.resolve('../src/native')];
  const native = require('../src/native');
  native.setDependencies({
    platform: 'darwin',
    commandExists: () => available,
    isSystemdBooted: () => true
  });
  const backend = require('../src/backend');
  return { backend, native };
};

const makeState = () => ({
  isCaffeinated: false,
  powerSaveBlockerId: null,
  caffeinateProcess: null
});

const mockConfig = sleepBackend => {
  const configPath = require.resolve('../src/config');
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { getConfig: () => ({ sleep_backend: sleepBackend }) }
  };
};

const mockElectron = () => {
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
  const electronPath = require.resolve('../src/electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { getElectron: () => ({ powerSaveBlocker }) }
  };
  return calls;
};

test('getSleepBackend returns native when configured and available', () => {
  mockConfig('native');
  const { backend } = loadBoth({ available: true });

  assert.strictEqual(backend.getSleepBackend(), 'native');
});

test('getSleepBackend falls back to electron with one warning when native is unavailable', t => {
  const errors = t.mock.method(console, 'error', () => {});
  mockConfig('native');
  const { backend } = loadBoth({ available: false });

  assert.strictEqual(backend.getSleepBackend(), 'electron');
  assert.strictEqual(backend.getSleepBackend(), 'electron');
  assert.strictEqual(errors.mock.callCount(), 1);
});

test('getSleepBackend returns electron when configured for electron', () => {
  mockConfig('electron');
  const { backend } = loadBoth({ available: true });

  assert.strictEqual(backend.getSleepBackend(), 'electron');
});

test('enableCaffeine dispatches to the native backend when configured', () => {
  mockConfig('native');
  const { backend, native } = loadBoth();
  const child = { killed: false, on: () => child, kill: () => undefined };
  native.setDependencies({ spawn: () => child });

  const state = makeState();
  backend.enableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, true);
  assert.strictEqual(state.caffeinateProcess, child);
});

test('disableCaffeine dispatches to the native backend when configured', () => {
  mockConfig('native');
  const { backend, native } = loadBoth();
  const child = {
    killed: false,
    on: () => child,
    kill: () => {
      child.killed = true;
    }
  };
  native.setDependencies({ spawn: () => child });

  const state = makeState();
  backend.enableCaffeine(state);
  backend.disableCaffeine(state);

  assert.strictEqual(child.killed, true);
  assert.strictEqual(state.isCaffeinated, false);
});

test('enableCaffeine uses powerSaveBlocker when native is configured but unavailable', t => {
  t.mock.method(console, 'error', () => {});
  mockConfig('native');
  const calls = mockElectron();
  const { backend } = loadBoth({ available: false });

  const state = makeState();
  backend.enableCaffeine(state);

  assert.strictEqual(state.powerSaveBlockerId, 1);
  assert.deepStrictEqual(calls.start, ['prevent-app-suspension']);
});

test('enableCaffeine uses powerSaveBlocker for the electron backend', () => {
  mockConfig('electron');
  const calls = mockElectron();
  const { enableCaffeine } = loadBackend();

  const state = makeState();
  enableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, true);
  assert.strictEqual(state.powerSaveBlockerId, 1);
  assert.deepStrictEqual(calls.start, ['prevent-app-suspension']);
});

test('disableCaffeine uses powerSaveBlocker for the electron backend', () => {
  mockConfig('electron');
  const calls = mockElectron();
  const { disableCaffeine } = loadBackend();

  const state = makeState();
  state.isCaffeinated = true;
  state.powerSaveBlockerId = 1;

  disableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, false);
  assert.strictEqual(state.powerSaveBlockerId, null);
  assert.deepStrictEqual(calls.stop, [1]);
});
