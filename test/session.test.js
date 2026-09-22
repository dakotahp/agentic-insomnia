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

test('removeSessionWithLock removes a specific session', async () => {
  makeTempHome();
  const { addSessionWithLock, removeSessionWithLock, getActiveSessionsWithLock } = loadSession();

  await addSessionWithLock('sess-1');
  await addSessionWithLock('sess-2');
  const result = await removeSessionWithLock('sess-1');

  assert.strictEqual(result.changes, 1);

  const active = await getActiveSessionsWithLock();
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].id, 'sess-2');
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
  const { initSessionsFile, readSessionsWithLock } = loadSession();

  await initSessionsFile();

  assert.ok(fs.existsSync(sessionsFile(home)));
  const data = await readSessionsWithLock();
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
