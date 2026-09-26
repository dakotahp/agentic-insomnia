const { getActiveSessionsWithLock } = require('./session');
const { enableCaffeine, disableCaffeine } = require('./backend');
const { isPidFileOwnedByOther, writeHeartbeat } = require('./pid');
const { getConfig } = require('./config');

// A failed check counts as active, so a read error never ends a session early.
const updateCaffeineStatus = async (state, onStateChange) => {
  try {
    const activeSessions = await getActiveSessionsWithLock();
    const shouldCaffeinate = activeSessions.length > 0;

    if (shouldCaffeinate && !state.isCaffeinated) {
      await enableCaffeine(state);
    } else if (!shouldCaffeinate && state.isCaffeinated) {
      await disableCaffeine(state);
    }

    if (onStateChange) {
      onStateChange(state);
    }

    return shouldCaffeinate;
  } catch (error) {
    console.error('Error updating caffeine status:', error);
    return true;
  }
};

const checkIdle = async (state, hasActiveSessions, onIdle) => {
  if (hasActiveSessions) {
    state.idleSince = null;
    return false;
  }

  state.idleSince = state.idleSince || Date.now();
  const idleTimeoutMs = getConfig().server_shutdown_minutes * 60 * 1000;

  if (!(idleTimeoutMs > 0) || Date.now() - state.idleSince < idleTimeoutMs) {
    return false;
  }

  console.error('No active sessions for too long, shutting this server down');
  stopPolling(state);
  await onIdle(state);
  return true;
};

// A missing or unreadable PID file keeps this server running.
const checkOwnership = async (state, onOwnershipLost) => {
  try {
    if (!(await isPidFileOwnedByOther(process.pid))) {
      return true;
    }
  } catch (error) {
    console.error('Error checking server ownership:', error.message);
    return true;
  }

  console.error('Another server owns the PID file, shutting this one down');
  stopPolling(state);
  await onOwnershipLost(state);
  return false;
};

const refreshHeartbeat = async () => {
  try {
    await writeHeartbeat(process.pid);
  } catch (error) {
    console.error('Error writing server heartbeat:', error.message);
  }
};

const startPolling = (state, interval, onStateChange, onOwnershipLost, onIdle) => {
  const poll = async () => {
    if (onOwnershipLost && !(await checkOwnership(state, onOwnershipLost))) {
      return;
    }
    await refreshHeartbeat();
    const hasActiveSessions = await updateCaffeineStatus(state, onStateChange);
    if (onIdle) {
      await checkIdle(state, hasActiveSessions, onIdle);
    }
  };

  poll();
  state.pollInterval = setInterval(poll, interval);

  // Expose a stop handle on the state so the UI layer can stop polling
  // without importing this module (breaks the poller <-> system-tray cycle).
  state.stopPolling = () => stopPolling(state);
};

const stopPolling = state => {
  if (state && state.pollInterval) {
    try {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
    } catch (error) {
      console.error('Error clearing interval:', error.message);
    }
  }
};

module.exports = {
  checkOwnership,
  checkIdle,
  startPolling,
  stopPolling
};
