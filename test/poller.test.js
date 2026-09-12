const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mockModule = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const loadPollerWithPidFile = pidFileContent => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-caffeine-poller-'));
  os.homedir = () => home;
  const configDir = path.join(home, '.claude', 'plugins', 'cc-caffeine');
  fs.mkdirSync(configDir, { recursive: true });

  if (pidFileContent !== undefined) {
    fs.writeFileSync(path.join(configDir, 'server.pid'), String(pidFileContent));
  }

  mockModule('../src/session', {
    getActiveSessionsWithLock: async () => [],
    cleanupExpiredSessionsWithLock: async () => {}
  });
  mockModule('../src/backend', {
    enableCaffeine: async () => {},
    disableCaffeine: async () => {}
  });
  delete require.cache[require.resolve('../src/pid')];
  delete require.cache[require.resolve('../src/poller')];
  return require('../src/poller');
};

const recordCalls = () => {
  const calls = [];
  const callback = async state => {
    calls.push(state);
  };
  return { calls, callback };
};

test('checkOwnership keeps a server whose PID is in the PID file', async () => {
  const { checkOwnership } = loadPollerWithPidFile(process.pid);
  const { calls, callback } = recordCalls();

  assert.strictEqual(await checkOwnership({}, callback), true);
  assert.strictEqual(calls.length, 0);
});

test('checkOwnership keeps a server when the PID file is missing', async () => {
  const { checkOwnership } = loadPollerWithPidFile();
  const { calls, callback } = recordCalls();

  assert.strictEqual(await checkOwnership({}, callback), true);
  assert.strictEqual(calls.length, 0);
});

test('checkOwnership stops polling and reports when another PID owns the file', async () => {
  const { checkOwnership } = loadPollerWithPidFile(process.pid + 1);
  const { calls, callback } = recordCalls();
  const interval = setInterval(() => {}, 60000);
  const state = { pollInterval: interval };

  try {
    assert.strictEqual(await checkOwnership(state, callback), false);
    assert.strictEqual(state.pollInterval, null);
    assert.deepStrictEqual(calls, [state]);
  } finally {
    clearInterval(interval);
  }
});
