const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const makeTempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-insomnia-pid-'));
  os.homedir = () => home;
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'agentic-insomnia'), { recursive: true });
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
  const pidFile = path.join(home, '.claude', 'plugins', 'agentic-insomnia', 'server.pid');
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

test('commandLineQuery uses ps with untruncated output on macOS and Linux', () => {
  makeTempHome();
  const { commandLineQuery } = loadPid();

  for (const platform of ['darwin', 'linux']) {
    assert.deepStrictEqual(commandLineQuery(4242, platform), {
      cmd: 'ps',
      args: ['-ww', '-p', '4242', '-o', 'command=']
    });
  }
});

test('commandLineQuery uses PowerShell CIM instead of wmic on Windows', () => {
  makeTempHome();
  const { commandLineQuery } = loadPid();

  const originalRoot = process.env.SystemRoot;
  process.env.SystemRoot = 'D:\\Win';
  try {
    const { cmd, args } = commandLineQuery(4242, 'win32');

    assert.strictEqual(cmd, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepStrictEqual(args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_Process -Filter \'ProcessId=4242\').CommandLine'
    ]);
  } finally {
    if (originalRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = originalRoot;
    }
  }
});

test('commandLineQuery only ever embeds an integer PID', () => {
  makeTempHome();
  const { commandLineQuery } = loadPid();

  const { args } = commandLineQuery('1\'; Remove-Item x; \'', 'win32');

  assert.ok(!args[3].includes('Remove-Item'));
});

const pidFilePath = home => path.join(home, '.claude', 'plugins', 'agentic-insomnia', 'server.pid');

test('writePidFile leaves a fresh heartbeat for that PID', async () => {
  makeTempHome();
  const { writePidFile, isHeartbeatFresh } = loadPid();

  await writePidFile(12345);

  assert.strictEqual(await isHeartbeatFresh(12345), true);
});

test('isHeartbeatFresh is false when missing, for another PID, or when old', async () => {
  makeTempHome();
  const pid = loadPid();

  assert.strictEqual(await pid.isHeartbeatFresh(12345), false);

  await pid.writePidFile(12345);
  assert.strictEqual(await pid.isHeartbeatFresh(54321), false);

  pid.setDependencies({ now: () => Date.now() + pid.HEARTBEAT_STALE_MS + 1000 });
  assert.strictEqual(await pid.isHeartbeatFresh(12345), false);
});

test('writeHeartbeat refreshes the PID file without changing it', async () => {
  const home = makeTempHome();
  const pid = loadPid();
  await pid.writePidFile(12345);
  const old = new Date(Date.now() - pid.HEARTBEAT_STALE_MS - 1000);
  fs.utimesSync(pidFilePath(home), old, old);
  assert.strictEqual(await pid.isHeartbeatFresh(12345), false);

  await pid.writeHeartbeat();

  assert.strictEqual(await pid.isHeartbeatFresh(12345), true);
  assert.strictEqual(fs.readFileSync(pidFilePath(home), 'utf8'), '12345');
});

test('writeHeartbeat does not create a missing PID file', async () => {
  const home = makeTempHome();
  const { writeHeartbeat } = loadPid();

  await assert.rejects(writeHeartbeat(), { code: 'ENOENT' });
  assert.strictEqual(fs.existsSync(pidFilePath(home)), false);
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`validatePid on ${platform} trusts a fresh heartbeat without reading the command line`, async () => {
    makeTempHome();
    const pid = loadPid();
    pid.setDependencies({ platform });

    await pid.writePidFile(process.pid);

    assert.strictEqual(await pid.validatePid(process.pid), true);
  });
}

test('validatePid ignores a fresh heartbeat when the PID is dead', async () => {
  makeTempHome();
  const pid = loadPid();

  await pid.writePidFile(999999);

  assert.strictEqual(await pid.validatePid(999999), false);
});

test('validatePid recognizes a native node caffeine server', async () => {
  makeTempHome();
  const { spawn } = require('child_process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-insomnia-validate-'));
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

test('writePidFile records the backend next to the PID', async () => {
  makeTempHome();
  const pid = loadPid();

  await pid.writePidFile(12345, 'native');

  assert.strictEqual(await pid.readPidFile(), 12345);
  assert.strictEqual(await pid.readServerBackend(), 'native');
  assert.strictEqual(await pid.isHeartbeatFresh(12345), true);
});

test('readServerBackend is null for a PID file from an older server', async () => {
  const home = makeTempHome();
  fs.writeFileSync(pidFilePath(home), '12345');
  const { readServerBackend } = loadPid();

  assert.strictEqual(await readServerBackend(), null);
});
