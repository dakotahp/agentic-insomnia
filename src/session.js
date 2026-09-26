const fs = require('fs');
const path = require('path');
const os = require('os');
const lockfile = require('proper-lockfile');
const { getConfig } = require('./config');

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'plugins', 'agentic-insomnia');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
const getSessionTimeout = () => getConfig().stale_session_minutes * 60 * 1000;
const getGracePeriod = () => getConfig().stay_awake_after_turn_minutes * 60 * 1000;
const MAX_RETRIES = 10;

/**
 * Whether a session still holds the sleep lock.
 *
 * Once `ended_at` is stamped the grace window governs alone, so a long-running
 * session that just ended is not dropped by the session timeout as well.
 * @param {object} sessionData - A session entry from sessions.json
 * @param {Date} now - The current time
 * @returns {boolean}
 */
const sessionHoldsLock = (sessionData, now) => {
  if (sessionData.ended_at) {
    return now - new Date(sessionData.ended_at) < getGracePeriod();
  }

  return now - new Date(sessionData.last_activity) < getSessionTimeout();
};

const emptySessions = () => ({ sessions: {}, last_updated: new Date().toISOString() });

const initSessionsFile = async () => {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(emptySessions(), null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

const readSessionsFile = () => {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
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
  const tempFile = `${SESSIONS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, SESSIONS_FILE);
};

const readSessionsWithLock = async (retryCount = 0) => {
  try {
    await initSessionsFile();

    const release = await lockfile.lock(SESSIONS_FILE, {
      retries: MAX_RETRIES,
      stale: 30000 // 30 seconds
    });

    try {
      return readSessionsFile();
    } finally {
      await release();
    }
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      console.warn(`Retry ${retryCount + 1}/${MAX_RETRIES} for readSessionsWithLock`);
      await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount)));
      return readSessionsWithLock(retryCount + 1);
    }
    throw error;
  }
};

// Note: Individual write operations should use addSession/removeSession for atomicity

const addSessionWithLock = async sessionId => {
  await initSessionsFile();

  const release = await lockfile.lock(SESSIONS_FILE, {
    retries: MAX_RETRIES,
    stale: 30000 // 30 seconds
  });

  try {
    // Read data while holding the lock
    const data = readSessionsFile();
    const now = new Date().toISOString();

    // Clean up expired sessions first
    const nowDate = new Date();
    let removedCount = 0;

    for (const [existingSessionId, sessionData] of Object.entries(data.sessions)) {
      if (!sessionHoldsLock(sessionData, nowDate)) {
        delete data.sessions[existingSessionId];
        removedCount++;
      }
    }

    // Add or update the session
    let isNewSession = false;
    if (data.sessions[sessionId]) {
      data.sessions[sessionId].last_activity = now;
      data.sessions[sessionId].ended_at = null;
    } else {
      // Create new session
      data.sessions[sessionId] = {
        created_at: now,
        last_activity: now,
        ended_at: null,
        project_dir: process.env.CLAUDE_PROJECT_DIR
      };
      isNewSession = true;
    }

    // Write updated data while still holding the lock
    data.last_updated = now;
    writeSessionsFile(data);

    const action = isNewSession ? 'added' : 'updated';

    // console.error(`Cleaned up ${removedCount} expired sessions and ${action} session: ${sessionId}`);
    return { id: sessionId, cleaned_sessions: removedCount, action };
  } finally {
    await release();
  }
};

const removeSessionWithLock = async sessionId => {
  await initSessionsFile();

  const release = await lockfile.lock(SESSIONS_FILE, {
    retries: MAX_RETRIES,
    stale: 30000 // 30 seconds
  });

  try {
    // Read data while holding the lock
    const data = readSessionsFile();
    const now = new Date().toISOString();
    let changes = 0;

    // Clean up expired sessions first
    const nowDate = new Date();
    let cleanedCount = 0;

    for (const [existingSessionId, sessionData] of Object.entries(data.sessions)) {
      if (!sessionHoldsLock(sessionData, nowDate)) {
        delete data.sessions[existingSessionId];
        cleanedCount++;
      }
    }

    // Several hooks fire uncaffeinate for one turn. Without the ended_at guard
    // each one would push the grace window forward and it would never close.
    if (data.sessions[sessionId] && !data.sessions[sessionId].ended_at) {
      data.sessions[sessionId].ended_at = now;
      changes = 1;
    }

    // Write updated data while still holding the lock
    if (changes > 0 || cleanedCount > 0) {
      data.last_updated = now;
      writeSessionsFile(data);
    }

    if (cleanedCount > 0) {
      // console.error(`Cleaned up ${cleanedCount} expired sessions`);
    }

    return { changes, cleaned_sessions: cleanedCount };
  } finally {
    await release();
  }
};

const getActiveSessionsWithLock = async () => {
  await initSessionsFile();

  const release = await lockfile.lock(SESSIONS_FILE, {
    retries: MAX_RETRIES,
    stale: 30000 // 30 seconds
  });

  try {
    const data = readSessionsFile();
    const now = new Date();
    const activeSessions = [];

    for (const [sessionId, sessionData] of Object.entries(data.sessions)) {
      if (sessionHoldsLock(sessionData, now)) {
        activeSessions.push({
          id: sessionId,
          ...sessionData
        });
      }
    }

    return activeSessions;
  } finally {
    await release();
  }
};

const cleanupExpiredSessionsWithLock = async () => {
  await initSessionsFile();

  const release = await lockfile.lock(SESSIONS_FILE, {
    retries: MAX_RETRIES,
    stale: 30000 // 30 seconds
  });

  try {
    const data = readSessionsFile();
    const now = new Date();
    let removedCount = 0;

    for (const [sessionId, sessionData] of Object.entries(data.sessions)) {
      if (!sessionHoldsLock(sessionData, now)) {
        delete data.sessions[sessionId];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      data.last_updated = new Date().toISOString();
      writeSessionsFile(data);
    }

    return { changes: removedCount };
  } finally {
    await release();
  }
};

module.exports = {
  initSessionsFile,
  sessionHoldsLock,
  readSessionsWithLock,
  addSessionWithLock,
  removeSessionWithLock,
  getActiveSessionsWithLock,
  cleanupExpiredSessionsWithLock
};
