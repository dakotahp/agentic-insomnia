const fs = require('fs');
const lockfile = require('proper-lockfile');
const { getConfig } = require('./config');
const { configPath } = require('./paths');

const sessionsFile = () => configPath('sessions.json');
const getSessionTimeout = () => getConfig().stale_session_minutes * 60 * 1000;
const getGracePeriod = () => getConfig().stay_awake_after_turn_minutes * 60 * 1000;
const getLongToolCallLimit = () => getConfig().long_tool_call_minutes * 60 * 1000;
const LOCK_OPTIONS = { retries: 10, stale: 30000 };

// Once `ended_at` is stamped the grace window governs alone, so a long-running
// session that just ended is not dropped by the session timeout as well.
const sessionHoldsLock = (sessionData, now) => {
  if (sessionData.ended_at) {
    return now - new Date(sessionData.ended_at) < getGracePeriod();
  }

  // A tool call sends no hooks while it runs, so the stale timeout alone would
  // drop a session in the middle of a long one.
  if (
    sessionData.tool_started_at &&
    now - new Date(sessionData.tool_started_at) < getLongToolCallLimit()
  ) {
    return true;
  }

  return now - new Date(sessionData.last_activity) < getSessionTimeout();
};

const emptySessions = () => ({ sessions: {}, last_updated: new Date().toISOString() });

const initSessionsFile = async () => {
  try {
    fs.writeFileSync(sessionsFile(), JSON.stringify(emptySessions(), null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

const readSessionsFile = () => {
  try {
    const data = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    if (data && typeof data.sessions === 'object' && data.sessions !== null) {
      return data;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  console.error('Warning: sessions.json is corrupt, treating it as having no sessions');
  return emptySessions();
};

// Rename is atomic, so a process that dies mid-write cannot leave a truncated file.
const writeSessionsFile = data => {
  const tempFile = `${sessionsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, sessionsFile());
};

const withSessions = async operation => {
  await initSessionsFile();
  const release = await lockfile.lock(sessionsFile(), LOCK_OPTIONS);

  try {
    const data = readSessionsFile();
    const original = JSON.stringify(data.sessions);
    const now = new Date();

    let cleaned = 0;
    for (const [id, sessionData] of Object.entries(data.sessions)) {
      if (!sessionHoldsLock(sessionData, now)) {
        delete data.sessions[id];
        cleaned++;
      }
    }

    const result = operation(data.sessions, now.toISOString());

    if (JSON.stringify(data.sessions) !== original) {
      data.last_updated = now.toISOString();
      writeSessionsFile(data);
    }

    return { result, cleaned };
  } finally {
    await release();
  }
};

// `tool` is 'start' or 'end' for tool hooks. Any other activity, such as a new
// prompt, also clears the tool mark, so an interrupted tool cannot leave it set.
const addSessionWithLock = async (sessionId, tool) => {
  const { result, cleaned } = await withSessions((sessions, now) => {
    const toolStartedAt = tool === 'start' ? now : null;
    const existing = sessions[sessionId];
    if (existing) {
      existing.last_activity = now;
      existing.ended_at = null;
      existing.tool_started_at = toolStartedAt;
      return 'updated';
    }

    sessions[sessionId] = {
      created_at: now,
      last_activity: now,
      ended_at: null,
      tool_started_at: toolStartedAt,
      project_dir: process.env.CLAUDE_PROJECT_DIR
    };
    return 'added';
  });

  return { id: sessionId, action: result, cleaned_sessions: cleaned };
};

const removeSessionWithLock = async sessionId => {
  const { result, cleaned } = await withSessions((sessions, now) => {
    const existing = sessions[sessionId];
    // Several hooks fire uncaffeinate for one turn. Without the ended_at guard
    // each one would push the grace window forward and it would never close.
    if (!existing || existing.ended_at) {
      return 0;
    }
    existing.ended_at = now;
    return 1;
  });

  return { changes: result, cleaned_sessions: cleaned };
};

const getActiveSessionsWithLock = async () => {
  const { result } = await withSessions(sessions =>
    Object.entries(sessions).map(([id, sessionData]) => ({ id, ...sessionData }))
  );
  return result;
};

module.exports = {
  initSessionsFile,
  sessionHoldsLock,
  addSessionWithLock,
  removeSessionWithLock,
  getActiveSessionsWithLock
};
