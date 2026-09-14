const { test } = require('node:test');
const assert = require('node:assert');

const { serverSpawnOptions } = require('../src/server');

test('serverSpawnOptions runs npm through a shell on Windows', () => {
  assert.deepStrictEqual(serverSpawnOptions('win32'), {
    detached: true,
    stdio: 'ignore',
    shell: true,
    windowsHide: true
  });
});

test('serverSpawnOptions spawns npm directly on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.strictEqual(serverSpawnOptions(platform).shell, false);
    assert.strictEqual(serverSpawnOptions(platform).detached, true);
  }
});
