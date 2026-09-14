/**
 * Poller module - Decides when to prevent/release sleep
 *
 * Polls the session store and toggles the backend on/off. It does not know
 * about the UI: the caller injects an `onStateChange` callback so the tray
 * layer can react without the poller importing it (breaking the old cycle).
 */

const { getActiveSessionsWithLock, cleanupExpiredSessionsWithLock } = require('./session');
const { enableCaffeine, disableCaffeine } = require('./backend');
const { isPidFileOwnedByOther, writeHeartbeat } = require('./pid');

/**
 * Update caffeine status based on active sessions
 * @param {object} state - Tray state object
 * @param {(state: object) => void} [onStateChange] - Optional UI callback
 */
const updateCaffeineStatus = async (state, onStateChange) => {
  if (!state) {
    return;
  }

  try {
    await cleanupExpiredSessionsWithLock();
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
  } catch (error) {
    console.error('Error updating caffeine status:', error);
  }
};

/**
 * Stop polling and call `onOwnershipLost` when the PID file names another server.
 * A missing or unreadable PID file keeps this server running.
 * @param {object} state - Tray state object
 * @param {(state: object) => Promise<void>} onOwnershipLost - Shuts this server down
 * @returns {Promise<boolean>} True if this server still owns the PID file
 */
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

/**
 * Record that this server is alive, so clients can skip slow process lookups
 */
const refreshHeartbeat = async () => {
  try {
    await writeHeartbeat(process.pid);
  } catch (error) {
    console.error('Error writing server heartbeat:', error.message);
  }
};

/**
 * Start polling for session changes
 * @param {object} state - Tray state object
 * @param {number} [interval=10000] - Poll interval in ms
 * @param {(state: object) => void} [onStateChange] - Optional UI callback
 * @param {(state: object) => Promise<void>} [onOwnershipLost] - Called when another server owns the PID file
 */
const startPolling = (state, interval = 10000, onStateChange, onOwnershipLost) => {
  const poll = async () => {
    if (onOwnershipLost && !(await checkOwnership(state, onOwnershipLost))) {
      return;
    }
    await refreshHeartbeat();
    await updateCaffeineStatus(state, onStateChange);
  };

  poll();
  state.pollInterval = setInterval(poll, interval);

  // Expose a stop handle on the state so the UI layer can stop polling
  // without importing this module (breaks the poller <-> system-tray cycle).
  state.stopPolling = () => stopPolling(state);
};

/**
 * Stop polling
 * @param {object} state - Tray state object
 */
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
  updateCaffeineStatus,
  checkOwnership,
  startPolling,
  stopPolling
};
