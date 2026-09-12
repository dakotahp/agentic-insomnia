const { test } = require('node:test');
const assert = require('node:assert');

const loadNative = () => {
  delete require.cache[require.resolve('../src/native')];
  return require('../src/native');
};

const makeState = () => ({
  isCaffeinated: false,
  caffeinateProcess: null
});

const makeFakeChild = () => {
  const handlers = {};
  const stderrHandlers = {};
  const child = {
    killed: false,
    stderr: {
      on: (event, cb) => {
        stderrHandlers[event] = cb;
      }
    },
    on: (event, cb) => {
      handlers[event] = cb;
      return child;
    },
    kill: () => {
      child.killed = true;
      if (handlers.exit) {
        handlers.exit(null, 'SIGTERM');
      }
    }
  };
  return { child, handlers, stderrHandlers };
};

const loadWith = (overrides = {}) => {
  const native = loadNative();
  const calls = [];
  const { child, handlers, stderrHandlers } = makeFakeChild();
  let clock = 1000;
  native.setDependencies({
    platform: 'darwin',
    commandExists: () => true,
    isSystemdBooted: () => true,
    now: () => clock,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return child;
    },
    ...overrides
  });
  const advance = ms => {
    clock += ms;
  };
  return { native, calls, child, handlers, stderrHandlers, advance };
};

test('resolveNativeCommand returns caffeinate -i on macOS', () => {
  const { resolveNativeCommand } = loadNative();

  const command = resolveNativeCommand('darwin');

  assert.strictEqual(command.cmd, 'caffeinate');
  assert.deepStrictEqual(command.args, ['-i']);
  assert.strictEqual(command.stdio, 'ignore');
});

test('resolveNativeCommand returns systemd-inhibit holding cat on Linux', () => {
  const { resolveNativeCommand } = loadNative();

  const command = resolveNativeCommand('linux');

  assert.strictEqual(command.cmd, 'systemd-inhibit');
  assert.deepStrictEqual(command.args, [
    '--what=sleep:idle',
    '--who=cc-caffeine',
    '--why=Claude Code session active',
    '--mode=block',
    'cat'
  ]);
  assert.deepStrictEqual(command.stdio, ['pipe', 'ignore', 'pipe']);
});

test('resolveNativeCommand returns null on unsupported platforms', () => {
  const { resolveNativeCommand } = loadNative();

  assert.strictEqual(resolveNativeCommand('win32'), null);
});

test('isAvailable is true on macOS when caffeinate is on PATH', () => {
  const { native } = loadWith({
    platform: 'darwin',
    commandExists: name => name === 'caffeinate'
  });

  assert.strictEqual(native.isAvailable(), true);
});

test('isAvailable is true on Linux when booted with systemd and the binary exists', () => {
  const { native } = loadWith({
    platform: 'linux',
    commandExists: name => name === 'systemd-inhibit'
  });

  assert.strictEqual(native.isAvailable(), true);
});

test('isAvailable is false on Linux when not booted with systemd', () => {
  const { native } = loadWith({ platform: 'linux', isSystemdBooted: () => false });

  assert.strictEqual(native.isAvailable(), false);
});

test('isAvailable is false on Linux when systemd-inhibit is missing', () => {
  const { native } = loadWith({ platform: 'linux', commandExists: () => false });

  assert.strictEqual(native.isAvailable(), false);
});

test('isAvailable is false on unsupported platforms', () => {
  const { native } = loadWith({ platform: 'win32' });

  assert.strictEqual(native.isAvailable(), false);
});

test('enableCaffeine spawns caffeinate -i on macOS and stores the child', () => {
  const { native, calls, child } = loadWith();

  const state = makeState();
  native.enableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, true);
  assert.strictEqual(state.caffeinateProcess, child);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'caffeinate');
  assert.deepStrictEqual(calls[0].args, ['-i']);
});

test('enableCaffeine spawns systemd-inhibit with a stdin pipe on Linux', () => {
  const { native, calls, child } = loadWith({ platform: 'linux' });

  const state = makeState();
  native.enableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, true);
  assert.strictEqual(state.caffeinateProcess, child);
  assert.strictEqual(calls[0].cmd, 'systemd-inhibit');
  assert.deepStrictEqual(calls[0].opts.stdio, ['pipe', 'ignore', 'pipe']);
});

test('enableCaffeine is a no-op when already caffeinated', () => {
  const { native, calls } = loadWith();

  const state = makeState();
  state.isCaffeinated = true;
  state.caffeinateProcess = makeFakeChild().child;

  native.enableCaffeine(state);

  assert.strictEqual(calls.length, 0);
});

test('disableCaffeine kills the child and clears state', () => {
  const { native, child } = loadWith();

  const state = makeState();
  native.enableCaffeine(state);
  native.disableCaffeine(state);

  assert.strictEqual(child.killed, true);
  assert.strictEqual(state.isCaffeinated, false);
  assert.strictEqual(state.caffeinateProcess, null);
  assert.strictEqual(state.nativeFailure, undefined);
});

test('disableCaffeine is a no-op when not caffeinated', () => {
  const { native } = loadWith();
  const state = makeState();

  native.disableCaffeine(state);

  assert.strictEqual(state.isCaffeinated, false);
  assert.strictEqual(state.caffeinateProcess, null);
});

test('a late child exit clears state so the next poll can respawn', () => {
  const { native, calls, handlers, advance } = loadWith();

  const state = makeState();
  native.enableCaffeine(state);
  advance(native.EARLY_EXIT_MS);
  handlers.exit(0, null);

  assert.strictEqual(state.isCaffeinated, false);
  assert.strictEqual(state.caffeinateProcess, null);
  assert.strictEqual(state.nativeFailure, undefined);

  native.enableCaffeine(state);
  assert.strictEqual(calls.length, 2);
});

test('an early child exit records a failure with stderr and stops respawning', t => {
  const errors = t.mock.method(console, 'error', () => {});
  const { native, calls, handlers, stderrHandlers, advance } = loadWith({ platform: 'linux' });

  const state = makeState();
  native.enableCaffeine(state);
  stderrHandlers.data(Buffer.from('Failed to inhibit: Access denied\n'));
  advance(native.EARLY_EXIT_MS - 1);
  handlers.exit(1, null);

  assert.strictEqual(state.isCaffeinated, false);
  assert.strictEqual(state.caffeinateProcess, null);
  assert.match(state.nativeFailure, /systemd-inhibit exited early/);
  assert.match(state.nativeFailure, /Access denied/);

  native.enableCaffeine(state);
  native.enableCaffeine(state);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(errors.mock.callCount(), 1);
});

test('a spawn error records a failure instead of crashing', t => {
  const errors = t.mock.method(console, 'error', () => {});
  const { native, calls, handlers } = loadWith({ platform: 'linux' });

  const state = makeState();
  native.enableCaffeine(state);
  const error = Object.assign(new Error('spawn systemd-inhibit ENOENT'), { code: 'ENOENT' });
  handlers.error(error);

  assert.strictEqual(state.isCaffeinated, false);
  assert.strictEqual(state.caffeinateProcess, null);
  assert.match(state.nativeFailure, /ENOENT/);

  native.enableCaffeine(state);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(errors.mock.callCount(), 1);
});

test('enableCaffeine records a failure on an unsupported platform', t => {
  t.mock.method(console, 'error', () => {});
  const { native, calls } = loadWith({ platform: 'win32' });

  const state = makeState();
  native.enableCaffeine(state);

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(state.isCaffeinated, false);
  assert.match(state.nativeFailure, /win32/);
});
