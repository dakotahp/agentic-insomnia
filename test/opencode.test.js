const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// The plugin is an ESM module (OpenCode's loader requires it), so load it via
// dynamic import. A unique query string per call gives a fresh module
// instance so spawn state stays isolated between tests.
//
// The module exports only `default` — no other named exports — because
// OpenCode's plugin loader (as of 1.18.30) calls every exported value as a
// plugin factory (https://github.com/anomalyco/opencode/issues/13543), so a
// second export would crash real usage. That means these tests can't reach
// internals like `actionForEvent` or `extractSessionId` directly; they drive
// the plugin the same way OpenCode does; through the hooks object the
// default export returns, injecting a fake spawn via the `testSpawnFn`
// plugin option.
const loadOpencode = async () => {
  const mod = await import(`../opencode/agentic-insomnia.mjs?bust=${Date.now()}-${Math.random()}`);
  return mod.default;
};

const makeFakeChild = () => {
  let stdin = '';
  let args = null;
  let command = null;
  const child = {
    stdin: {
      write: chunk => {
        stdin += chunk;
        return true;
      },
      end: () => {}
    },
    // Fire close on the next tick after it's registered, not on a tick
    // scheduled up front, so the run() promise resolves regardless of how
    // long createHooks's dynamic import takes to register the listener.
    on: (event, cb) => {
      if (event === 'close') {
        process.nextTick(cb);
      }
      return child;
    }
  };
  return {
    testSpawnFn: (cmd, spawnArgs) => {
      command = cmd;
      args = spawnArgs;
      return child;
    },
    getStdin: () => stdin,
    getCommand: () => command,
    getArgs: () => args,
    getAction: () => args && args[args.length - 1]
  };
};

const createHooks = async (ctx, testSpawnFn) => {
  const AgenticInsomnia = await loadOpencode();
  return AgenticInsomnia(ctx, testSpawnFn ? { testSpawnFn } : undefined);
};

test('createHooks returns the expected hook keys', async () => {
  const hooks = await createHooks({ directory: '/tmp/proj' });

  assert.ok(typeof hooks.event === 'function');
  assert.ok(typeof hooks['tool.execute.before'] === 'function');
  assert.ok(typeof hooks['tool.execute.after'] === 'function');
});

test('event hook caffeinates on session.created with the session id', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'sess-1' } } } });

  assert.strictEqual(fake.getAction(), 'caffeinate');
  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'sess-1' });
});

test('runs the caffeine.js next to the plugin with node', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks['tool.execute.before']({ sessionID: 'sess-cli' });

  assert.strictEqual(fake.getCommand(), 'node');
  assert.deepStrictEqual(fake.getArgs(), [
    path.join(__dirname, '..', 'caffeine.js'),
    'caffeinate'
  ]);
});

test('event hook caffeinates on command.executed with the session id', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks.event({ event: { type: 'command.executed', properties: { sessionID: 'sess-cmd' } } });

  assert.strictEqual(fake.getAction(), 'caffeinate');
  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'sess-cmd' });
});

test('event hook caffeinates on user message.updated with the session id', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks.event({
    event: { type: 'message.updated', properties: { info: { role: 'user', sessionID: 'sess-3' } } }
  });

  assert.strictEqual(fake.getAction(), 'caffeinate');
  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'sess-3' });
});

test('event hook ignores assistant message.updated (only user activity caffeinates)', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks.event({
    event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 's' } } }
  });

  assert.strictEqual(fake.getAction(), null);
});

test('event hook uncaffeinates on session.idle with the session id', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'sess-2' } } });

  assert.strictEqual(fake.getAction(), 'uncaffeinate');
  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'sess-2' });
});

test('event hook uncaffeinates on session.deleted', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'sess-del' } } } });

  assert.strictEqual(fake.getAction(), 'uncaffeinate');
  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'sess-del' });
});

test('event hook ignores irrelevant events without spawning', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks.event({ event: { type: 'session.status', properties: {} } });
  await hooks.event({ event: { type: 'unknown.event', properties: {} } });
  // Tool events are handled by the named tool.execute.* hooks below, not the
  // catch-all event hook, so the event hook must ignore them.
  await hooks.event({ event: { type: 'tool.execute.before', properties: {} } });

  assert.strictEqual(fake.getAction(), null);
});

test('tool.execute.before caffeinates using the input session id', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks['tool.execute.before']({ sessionID: 'sess-4' });

  assert.strictEqual(fake.getAction(), 'caffeinate');
  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'sess-4' });
});

test('tool.execute.after caffeinates using the input session id', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/proj' }, fake.testSpawnFn);

  await hooks['tool.execute.after']({ sessionID: 'sess-5' });

  assert.strictEqual(fake.getAction(), 'caffeinate');
  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'sess-5' });
});

test('event hook falls back to the directory basename when no id is present', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({ directory: '/tmp/my-project' }, fake.testSpawnFn);

  await hooks.event({ event: { type: 'session.idle', properties: {} } });

  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'my-project' });
});

test('event hook falls back to "opencode" when no id or directory is present', async () => {
  const fake = makeFakeChild();
  const hooks = await createHooks({}, fake.testSpawnFn);

  await hooks.event({ event: { type: 'session.idle', properties: {} } });

  assert.deepStrictEqual(JSON.parse(fake.getStdin()), { session_id: 'opencode' });
});

test('a spawn error does not reject the hook', async () => {
  const hooks = await createHooks({ directory: '/tmp/proj' }, () => {
    throw new Error('spawn failed');
  });

  await assert.doesNotReject(
    hooks.event({ event: { type: 'session.created', properties: { info: { id: 'sess-1' } } } })
  );
});
