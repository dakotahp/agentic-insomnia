const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mockModule = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const loadPollerWithPidFile = (pidFileContent, config = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-insomnia-poller-'));
  os.homedir = () => home;
  const configDir = path.join(home, '.claude', 'plugins', 'agentic-insomnia');
  fs.mkdirSync(configDir, { recursive: true });

  if (pidFileContent !== undefined) {
    fs.writeFileSync(path.join(configDir, 'server.pid'), String(pidFileContent));
  }

  mockModule('../src/session', {
    getActiveSessionsWithLock: async () => []
  });
  mockModule('../src/config', {
    getConfig: () => ({ server_shutdown_minutes: 30, ...config })
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

const agePidFile = () => {
  const pidFile = path.join(os.homedir(), '.claude', 'plugins', 'agentic-insomnia', 'server.pid');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(pidFile, old, old);
  return () => fs.statSync(pidFile).mtimeMs;
};

test('each poll refreshes the heartbeat on the PID file', async () => {
  const { startPolling, stopPolling } = loadPollerWithPidFile(process.pid);
  const readMtime = agePidFile();
  const state = {};

  startPolling(state, 60000, undefined, async () => {});
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(Date.now() - readMtime() < 5000);
  } finally {
    stopPolling(state);
  }
});

test('a server that lost ownership does not refresh the heartbeat', async () => {
  const { startPolling, stopPolling } = loadPollerWithPidFile(process.pid + 1);
  const readMtime = agePidFile();
  const before = readMtime();
  const state = {};

  startPolling(state, 60000, undefined, async () => {});
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(readMtime(), before);
  } finally {
    stopPolling(state);
  }
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

const MINUTE = 60 * 1000;

test('checkIdle shuts the server down after the idle timeout', async () => {
  const { checkIdle } = loadPollerWithPidFile();
  const { calls, callback } = recordCalls();
  const state = { idleSince: Date.now() - 31 * MINUTE };

  assert.strictEqual(await checkIdle(state, false, callback), true);
  assert.deepStrictEqual(calls, [state]);
});

test('checkIdle keeps the server before the idle timeout', async () => {
  const { checkIdle } = loadPollerWithPidFile();
  const { calls, callback } = recordCalls();
  const state = { idleSince: Date.now() - 5 * MINUTE };

  assert.strictEqual(await checkIdle(state, false, callback), false);
  assert.strictEqual(calls.length, 0);
});

test('checkIdle starts the idle clock on the first idle poll', async () => {
  const { checkIdle } = loadPollerWithPidFile();
  const { callback } = recordCalls();
  const state = {};

  await checkIdle(state, false, callback);
  assert.ok(state.idleSince <= Date.now() && state.idleSince > Date.now() - MINUTE);
});

test('checkIdle resets the idle clock when a session is active', async () => {
  const { checkIdle } = loadPollerWithPidFile();
  const { calls, callback } = recordCalls();
  const state = { idleSince: Date.now() - 31 * MINUTE };

  assert.strictEqual(await checkIdle(state, true, callback), false);
  assert.strictEqual(state.idleSince, null);
  assert.strictEqual(calls.length, 0);
});

test('checkIdle never shuts down when server_shutdown_minutes is 0', async () => {
  const { checkIdle } = loadPollerWithPidFile(undefined, { server_shutdown_minutes: 0 });
  const { calls, callback } = recordCalls();
  const state = { idleSince: Date.now() - 24 * 60 * MINUTE };

  assert.strictEqual(await checkIdle(state, false, callback), false);
  assert.strictEqual(calls.length, 0);
});

test('checkIdle stops polling when it shuts down', async () => {
  const { checkIdle } = loadPollerWithPidFile();
  const { callback } = recordCalls();
  const interval = setInterval(() => {}, 60000);
  const state = { pollInterval: interval, idleSince: Date.now() - 31 * MINUTE };

  try {
    await checkIdle(state, false, callback);
    assert.strictEqual(state.pollInterval, null);
  } finally {
    clearInterval(interval);
  }
});
