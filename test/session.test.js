const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const makeTempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-insomnia-session-'));
  os.homedir = () => home;
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'agentic-insomnia'), { recursive: true });
  return home;
};

const loadSession = () => {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/session')];
  return require('../src/session');
};

const MINUTE = 60 * 1000;
const iso = msAgo => new Date(Date.now() - msAgo).toISOString();

const sessionsFile = home =>
  path.join(home, '.claude', 'plugins', 'agentic-insomnia', 'sessions.json');

const writeSessions = (home, sessions) => {
  const file = sessionsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessions, last_updated: new Date().toISOString() }, null, 2));
};

test('addSessionWithLock adds a new session', async () => {
  makeTempHome();
  const { addSessionWithLock } = loadSession();

  const result = await addSessionWithLock('sess-1');

  assert.strictEqual(result.id, 'sess-1');
  assert.strictEqual(result.action, 'added');
  assert.strictEqual(result.cleaned_sessions, 0);
});

test('addSessionWithLock updates an existing session', async () => {
  makeTempHome();
  const { addSessionWithLock } = loadSession();

  await addSessionWithLock('sess-1');
  const result = await addSessionWithLock('sess-1');

  assert.strictEqual(result.action, 'updated');
});

test('getActiveSessionsWithLock returns only non-expired sessions', async () => {
  const home = makeTempHome();
  const now = Date.now();
  writeSessions(home, {
    'fresh': { created_at: new Date(now).toISOString(), last_activity: new Date(now).toISOString() },
    'stale': {
      created_at: new Date(now - 3600000).toISOString(),
      last_activity: new Date(now - 3600000).toISOString()
    }
  });

  const { getActiveSessionsWithLock } = loadSession();
  const active = await getActiveSessionsWithLock();

  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].id, 'fresh');
});

test('cleanupExpiredSessionsWithLock removes stale sessions', async () => {
  const home = makeTempHome();
  const now = Date.now();
  writeSessions(home, {
    'fresh': { created_at: new Date(now).toISOString(), last_activity: new Date(now).toISOString() },
    'stale': {
      created_at: new Date(now - 3600000).toISOString(),
      last_activity: new Date(now - 3600000).toISOString()
    }
  });

  const { cleanupExpiredSessionsWithLock } = loadSession();
  const result = await cleanupExpiredSessionsWithLock();

  assert.strictEqual(result.changes, 1);

  const { getActiveSessionsWithLock } = loadSession();
  const active = await getActiveSessionsWithLock();
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].id, 'fresh');
});

test('removeSessionWithLock ends a specific session and leaves the others running', async () => {
  const home = makeTempHome();
  const { addSessionWithLock, removeSessionWithLock } = loadSession();

  await addSessionWithLock('sess-1');
  await addSessionWithLock('sess-2');
  const result = await removeSessionWithLock('sess-1');

  assert.strictEqual(result.changes, 1);

  const data = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8'));
  assert.ok(data.sessions['sess-1'].ended_at, 'the named session should be stamped');
  assert.strictEqual(data.sessions['sess-2'].ended_at, null, 'others should be untouched');
});

test('an ended session stops counting as active once its grace window closes', async () => {
  const home = makeTempHome();
  const { getActiveSessionsWithLock } = loadSession();

  writeSessions(home, {
    'done': {
      created_at: iso(30 * MINUTE),
      last_activity: iso(9 * MINUTE),
      ended_at: iso(8 * MINUTE)
    },
    'running': {
      created_at: iso(30 * MINUTE),
      last_activity: iso(1 * MINUTE),
      ended_at: null
    }
  });

  const active = await getActiveSessionsWithLock();
  assert.deepStrictEqual(
    active.map(session => session.id),
    ['running']
  );
});

test('addSessionWithLock cleans up expired sessions on the way in', async () => {
  const home = makeTempHome();
  const now = Date.now();
  writeSessions(home, {
    'stale': {
      created_at: new Date(now - 3600000).toISOString(),
      last_activity: new Date(now - 3600000).toISOString()
    }
  });

  const { addSessionWithLock } = loadSession();
  const result = await addSessionWithLock('fresh');

  assert.strictEqual(result.cleaned_sessions, 1);
  assert.strictEqual(result.action, 'added');
});

test('initSessionsFile creates the file when missing', async () => {
  const home = makeTempHome();
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'agentic-insomnia'), { recursive: true });
  const { initSessionsFile } = loadSession();

  await initSessionsFile();

  const data = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8'));
  assert.deepStrictEqual(data.sessions, {});
});

test('sessionHoldsLock holds a session with recent activity and no end stamp', () => {
  makeTempHome();
  const { sessionHoldsLock } = loadSession();

  assert.strictEqual(sessionHoldsLock({ last_activity: iso(2 * MINUTE) }, new Date()), true);
});

test('sessionHoldsLock drops a session that went quiet without an end stamp', () => {
  makeTempHome();
  const { sessionHoldsLock } = loadSession();

  assert.strictEqual(sessionHoldsLock({ last_activity: iso(20 * MINUTE) }, new Date()), false);
});

test('sessionHoldsLock holds an ended session inside the grace window', () => {
  makeTempHome();
  const { sessionHoldsLock } = loadSession();

  assert.strictEqual(
    sessionHoldsLock({ last_activity: iso(3 * MINUTE), ended_at: iso(2 * MINUTE) }, new Date()),
    true
  );
});

test('sessionHoldsLock drops an ended session past the grace window', () => {
  makeTempHome();
  const { sessionHoldsLock } = loadSession();

  assert.strictEqual(
    sessionHoldsLock({ last_activity: iso(7 * MINUTE), ended_at: iso(6 * MINUTE) }, new Date()),
    false
  );
});

test('sessionHoldsLock ignores the session timeout once a session has ended', () => {
  makeTempHome();
  const { sessionHoldsLock } = loadSession();

  assert.strictEqual(
    sessionHoldsLock({ last_activity: iso(60 * MINUTE), ended_at: iso(1 * MINUTE) }, new Date()),
    true
  );
});

test('removeSessionWithLock stamps ended_at and keeps the session', async () => {
  const home = makeTempHome();
  const { addSessionWithLock, removeSessionWithLock } = loadSession();

  await addSessionWithLock('grace-1');
  await removeSessionWithLock('grace-1');

  const data = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8'));
  assert.ok(data.sessions['grace-1'], 'session should still exist');
  assert.ok(data.sessions['grace-1'].ended_at, 'ended_at should be set');
});

test('an ended session still counts as active inside the grace window', async () => {
  makeTempHome();
  const { addSessionWithLock, removeSessionWithLock, getActiveSessionsWithLock } = loadSession();

  await addSessionWithLock('grace-2');
  await removeSessionWithLock('grace-2');

  const active = await getActiveSessionsWithLock();
  assert.deepStrictEqual(
    active.map(session => session.id),
    ['grace-2']
  );
});

test('caffeinate clears ended_at so a new turn resumes the session', async () => {
  const home = makeTempHome();
  const { addSessionWithLock, removeSessionWithLock } = loadSession();

  await addSessionWithLock('grace-3');
  await removeSessionWithLock('grace-3');
  await addSessionWithLock('grace-3');

  const data = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8'));
  assert.strictEqual(data.sessions['grace-3'].ended_at, null);
});

test('a repeated uncaffeinate does not extend the grace window', async () => {
  const home = makeTempHome();
  const { addSessionWithLock, removeSessionWithLock } = loadSession();

  await addSessionWithLock('grace-5');
  await removeSessionWithLock('grace-5');
  const first = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8')).sessions['grace-5']
    .ended_at;

  await new Promise(resolve => setTimeout(resolve, 20));
  await removeSessionWithLock('grace-5');
  const second = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8')).sessions['grace-5']
    .ended_at;

  assert.strictEqual(second, first);
});

test('cleanupExpiredSessionsWithLock removes a session past its grace window', async () => {
  const home = makeTempHome();
  const { cleanupExpiredSessionsWithLock } = loadSession();

  writeSessions(home, {
    'grace-4': {
      created_at: iso(60 * MINUTE),
      last_activity: iso(11 * MINUTE),
      ended_at: iso(10 * MINUTE)
    }
  });

  await cleanupExpiredSessionsWithLock();

  const data = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8'));
  assert.strictEqual(data.sessions['grace-4'], undefined);
});

test('a corrupt sessions file counts as no active sessions', async t => {
  t.mock.method(console, 'error', () => {});
  const home = makeTempHome();
  fs.writeFileSync(sessionsFile(home), '{"sessions": {"half-writ');
  const { getActiveSessionsWithLock } = loadSession();

  assert.deepStrictEqual(await getActiveSessionsWithLock(), []);
});

test('a sessions file without a sessions object counts as no active sessions', async t => {
  t.mock.method(console, 'error', () => {});
  const home = makeTempHome();
  fs.writeFileSync(sessionsFile(home), 'null');
  const { getActiveSessionsWithLock } = loadSession();

  assert.deepStrictEqual(await getActiveSessionsWithLock(), []);
});

test('addSessionWithLock replaces a corrupt sessions file', async t => {
  t.mock.method(console, 'error', () => {});
  const home = makeTempHome();
  fs.writeFileSync(sessionsFile(home), 'not json');
  const { addSessionWithLock } = loadSession();

  await addSessionWithLock('sess-1');

  const data = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8'));
  assert.deepStrictEqual(Object.keys(data.sessions), ['sess-1']);
});

test('writes leave no temporary files behind', async () => {
  const home = makeTempHome();
  const { addSessionWithLock, removeSessionWithLock } = loadSession();

  await addSessionWithLock('sess-1');
  await removeSessionWithLock('sess-1');

  const files = fs.readdirSync(path.dirname(sessionsFile(home)));
  assert.deepStrictEqual(files.filter(name => name.endsWith('.tmp')), []);
});

test('initSessionsFile keeps an existing file', async () => {
  const home = makeTempHome();
  writeSessions(home, { kept: { created_at: iso(0), last_activity: iso(0) } });
  const { initSessionsFile } = loadSession();

  await initSessionsFile();

  const data = JSON.parse(fs.readFileSync(sessionsFile(home), 'utf8'));
  assert.deepStrictEqual(Object.keys(data.sessions), ['kept']);
});
