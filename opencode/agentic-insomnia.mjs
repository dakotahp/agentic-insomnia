/**
 * One file on purpose: OpenCode loads one plugin file.
 *
 * Exactly one export on purpose: OpenCode's plugin loader (as of 1.18.30) calls
 * every exported value as a plugin factory
 * (https://github.com/anomalyco/opencode/issues/13543), so a second export,
 * even a test-only helper, crashes every prompt. Tests inject through the
 * `options` argument OpenCode already passes to the factory (`testSpawnFn`).
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let spawnFn = spawn;

const ACTIVATE = new Set([
  'session.created',
  'command.executed',
  'message.updated'
]);

const DEACTIVATE = new Set(['session.idle', 'session.deleted']);

const actionForEvent = type => {
  if (DEACTIVATE.has(type)) {
    return 'uncaffeinate';
  }
  if (ACTIVATE.has(type)) {
    return 'caffeinate';
  }
  return null;
};

/**
 * The field carrying the session id differs by event shape (confirmed against
 * the opencode-notifier / opencode-wakatime plugins):
 *  - session.created / session.deleted / session.updated: properties.info.id
 *  - session.idle / session.status / command.executed:    properties.sessionID
 *  - message.updated:                                     properties.info.sessionID
 *  - tool.execute.before / tool.execute.after:            input.sessionID
 */
const extractSessionId = (event, input) => {
  if (input && typeof input.sessionID === 'string') {
    return input.sessionID;
  }
  if (event && typeof event.sessionID === 'string') {
    return event.sessionID;
  }

  const props = event && event.properties;
  if (!props) {
    return null;
  }
  if (typeof props.sessionID === 'string') {
    return props.sessionID;
  }

  const info = props.info;
  if (info && typeof info.id === 'string') {
    return info.id;
  }
  if (info && typeof info.sessionID === 'string') {
    return info.sessionID;
  }
  return null;
};

const CLI_PATH = path.join(__dirname, '..', 'caffeine.js');

const run = (action, sessionId) =>
  new Promise(resolve => {
    let child;
    try {
      child = spawnFn('node', [CLI_PATH, action], {
        stdio: ['pipe', 'ignore', 'ignore']
      });
    } catch {
      // A failed spawn must never reject a hook.
      resolve();
      return;
    }

    if (sessionId) {
      child.stdin.write(JSON.stringify({ session_id: sessionId }));
    }
    child.stdin.end();

    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });

const createHooks = ctx => {
  const directory = ctx && ctx.directory;
  const fallback = directory ? path.basename(directory) : 'opencode';

  const handle = async (action, sessionId) => {
    const id = sessionId || fallback;
    await run(action, id);
  };

  return {
    // Catch-all for session / command / message events. Tool events are ignored
    // here (actionForEvent returns null for them) and handled by the named
    // tool hooks below, so nothing fires twice.
    event: async ({ event }) => {
      const action = actionForEvent(event.type);
      if (!action) {
        return;
      }

      if (event.type === 'message.updated') {
        const info = event.properties && event.properties.info;
        if (!info || info.role !== 'user') {
          return;
        }
      }

      await handle(action, extractSessionId(event));
    },

    'tool.execute.before': async input => {
      await handle('caffeinate', extractSessionId(null, input));
    },
    'tool.execute.after': async input => {
      await handle('caffeinate', extractSessionId(null, input));
    }
  };
};

const AgenticInsomnia = async (ctx, options) => {
  if (options && typeof options.testSpawnFn === 'function') {
    spawnFn = options.testSpawnFn;
  }
  return createHooks(ctx);
};

export default AgenticInsomnia;
