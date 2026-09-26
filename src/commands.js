const {
  addSessionWithLock,
  removeSessionWithLock,
  getActiveSessionsWithLock
} = require('./session');
const { isServerRunningWithLock } = require('./pid');
const { runServerProcessIfNotStarted } = require('./server');
const { getConfig } = require('./config');
const { getSleepBackend } = require('./backend');
const { version } = require('../package.json');

const handleSessionCommand = async (action, sessionOperation) => {
  try {
    let input = '';
    process.stdin.setEncoding('utf8');

    await new Promise((resolve, reject) => {
      process.stdin.on('data', chunk => (input += chunk));
      process.stdin.on('end', resolve);
      process.stdin.on('error', reject);
    });

    const data = JSON.parse(input);
    const sessionId = data.session_id;

    if (!sessionId) {
      console.error('Error: session_id required in JSON input');
      process.exit(1);
    }

    const result = await sessionOperation(sessionId);

    if (action === 'caffeinate') {
      await runServerProcessIfNotStarted();
    }

    console.error(
      `${action === 'caffeinate' ? 'Enabled' : 'Disabled'} caffeine for session: ${sessionId}`
    );

    if (result.cleaned_sessions > 0) {
      console.error(`Cleaned up ${result.cleaned_sessions} expired sessions`);
    }

    return result;
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

const handleCaffeinate = () => {
  return handleSessionCommand('caffeinate', addSessionWithLock);
};

const handleUncaffeinate = () => {
  return handleSessionCommand('uncaffeinate', removeSessionWithLock);
};

const handleVersion = () => {
  console.log(version);
};

const handleStatus = async () => {
  try {
    const serverRunning = await isServerRunningWithLock();
    const activeSessions = await getActiveSessionsWithLock();

    console.error('=== Agentic Insomnia Status ===');
    console.error(`Server Status: ${serverRunning ? '✅ Running' : '❌ Stopped'}`);
    console.error(`Sleep Backend: ${getSleepBackend()}`);
    console.error(`Active Sessions: ${activeSessions.length}`);

    if (activeSessions.length > 0) {
      console.error('\nActive Sessions:');
      activeSessions.forEach((session, index) => {
        const created = new Date(session.created_at).toLocaleString();
        const lastActivity = new Date(session.last_activity).toLocaleString();
        console.error(`  ${index + 1}. ${session.id}`);
        console.error(`     Created: ${created}`);
        console.error(`     Last Activity: ${lastActivity}`);
        if (session.ended_at) {
          console.error(`     Ended: ${new Date(session.ended_at).toLocaleString()} (grace)`);
        }
        if (session.project_dir) {
          console.error(`     Project: ${session.project_dir}`);
        }
      });
    }

    console.error(
      `\nStay awake after a turn: ${getConfig().stay_awake_after_turn_minutes} minutes`
    );
    console.error(
      `Stale session after: ${getConfig().stale_session_minutes} minutes of inactivity`
    );
    console.error(
      `Server shutdown after: ${getConfig().server_shutdown_minutes} idle minutes`
    );
  } catch (error) {
    console.error('Error getting status:', error.message);
    process.exit(1);
  }
};

const handleUsage = () => {
  console.error('Usage: node caffeine.js [caffeinate|uncaffeinate|server|status|version]');
  console.error('');
  console.error('Commands:');
  console.error('  caffeinate     - Keep the machine awake for a session');
  console.error('  uncaffeinate   - End a session; sleep is allowed after the grace period');
  console.error('  server         - Start the caffeine server');
  console.error('  status         - Show current status and active sessions');
  console.error('  version        - Show the installed version');
  console.error('');
  console.error('caffeinate and uncaffeinate read the session id as JSON on stdin:');
  console.error('  echo \'{"session_id": "my-job"}\' | node caffeine.js caffeinate');
  process.exit(1);
};

module.exports = {
  handleCaffeinate,
  handleUncaffeinate,
  handleStatus,
  handleVersion,
  handleUsage
};
