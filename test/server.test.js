const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CAFFEINE_JS = path.join(__dirname, '..', 'caffeine.js');

const mockModule = (id, exports) => {
  const resolved = require.resolve(id);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const loadServer = backend => {
  mockModule('../src/backend', {
    getSleepBackend: () => backend,
    enableCaffeine: () => {},
    disableCaffeine: () => {}
  });
  delete require.cache[require.resolve('../src/server')];
  return require('../src/server');
};

test('serverCommand runs caffeine.js with this Node binary for the native backend', () => {
  const { serverCommand } = loadServer('native');

  assert.deepStrictEqual(serverCommand(), {
    cmd: process.execPath,
    args: [CAFFEINE_JS, 'server']
  });
});

test('serverCommand runs caffeine.js through the Electron CLI for the electron backend', () => {
  const { serverCommand } = loadServer('electron');

  assert.deepStrictEqual(serverCommand(), {
    cmd: process.execPath,
    args: [require.resolve('electron/cli.js'), CAFFEINE_JS, 'server']
  });
});
