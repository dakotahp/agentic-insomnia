const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const makeTempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-caffeine-pid-'));
  os.homedir = () => home;
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cc-caffeine'), { recursive: true });
  return home;
};

const loadPid = () => {
  delete require.cache[require.resolve('../src/pid')];
  return require('../src/pid');
};

test('readPidFile returns null when no PID file exists', async () => {
  makeTempHome();
  const { readPidFile } = loadPid();

  assert.strictEqual(await readPidFile(), null);
});

test('writePidFile then readPidFile round-trips', async () => {
  makeTempHome();
  const { writePidFile, readPidFile } = loadPid();

  await writePidFile(12345);

  assert.strictEqual(await readPidFile(), 12345);
});

test('readPidFile returns null for non-numeric content', async () => {
  const home = makeTempHome();
  const pidFile = path.join(home, '.claude', 'plugins', 'cc-caffeine', 'server.pid');
  fs.writeFileSync(pidFile, 'not-a-number');

  const { readPidFile } = loadPid();

  assert.strictEqual(await readPidFile(), null);
});

test('validatePid returns false for a dead PID', async () => {
  makeTempHome();
  const { validatePid } = loadPid();

  assert.strictEqual(await validatePid(999999), false);
});

test('validatePid returns false for a live non-caffeine process', async () => {
  makeTempHome();
  const { validatePid } = loadPid();

  assert.strictEqual(await validatePid(process.pid), false);
});

test('isPidFileOwnedByOther is false when no PID file exists', async () => {
  makeTempHome();
  const { isPidFileOwnedByOther } = loadPid();

  assert.strictEqual(await isPidFileOwnedByOther(process.pid), false);
});

test('isPidFileOwnedByOther is false when the PID file holds our PID', async () => {
  makeTempHome();
  const { writePidFile, isPidFileOwnedByOther } = loadPid();

  await writePidFile(process.pid);

  assert.strictEqual(await isPidFileOwnedByOther(process.pid), false);
});

test('isPidFileOwnedByOther is true when the PID file holds another PID', async () => {
  makeTempHome();
  const { writePidFile, isPidFileOwnedByOther } = loadPid();

  await writePidFile(process.pid + 1);

  assert.strictEqual(await isPidFileOwnedByOther(process.pid), true);
});

test('isStartupInProgress is false with no marker', async () => {
  makeTempHome();
  const { isStartupInProgress } = loadPid();

  assert.strictEqual(await isStartupInProgress(), false);
});

test('markStartupInProgress then isStartupInProgress is true', async () => {
  makeTempHome();
  const { markStartupInProgress, isStartupInProgress } = loadPid();

  await markStartupInProgress();

  assert.strictEqual(await isStartupInProgress(), true);
});

test('withPidLock runs the provided function and returns its value', async () => {
  makeTempHome();
  const { withPidLock } = loadPid();

  const result = await withPidLock(async () => 42);

  assert.strictEqual(result, 42);
});

test('isServerRunning is false when no PID file exists', async () => {
  makeTempHome();
  const { isServerRunning } = loadPid();

  assert.strictEqual(await isServerRunning(), false);
});

test('validatePid recognizes a native node caffeine server', async () => {
  makeTempHome();
  const { spawn } = require('child_process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-caffeine-validate-'));
  const script = path.join(dir, 'caffeine.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 10000);\n');

  const child = spawn(process.execPath, [script, 'server'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const { validatePid } = loadPid();
    assert.strictEqual(await validatePid(child.pid), true);
  } finally {
    child.kill();
  }
});
