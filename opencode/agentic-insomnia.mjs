/**
 * OpenCode plugin - translates OpenCode events into agentic-insomnia CLI calls.
 *
 * OpenCode has no external-command hook model like Claude Code; it exposes an
 * in-process plugin system. This module is self-contained: it maps OpenCode
 * events to the same `caffeinate`/`uncaffeinate` actions the Claude Code hooks
 * use, then shells out to the existing CLI so all session/server/idle-timeout
 * logic stays in one place. See "Integrations" in ARCHITECTURE.md for the event
 * mapping and the reasoning behind this being a single file.
 *
 * It is a single file on purpose: OpenCode loads one plugin file, so the plugin
 * being one file is a platform constraint, not an install convenience. It is
 * OpenCode-only (the Claude Code path uses caffeine.js directly), so there is no
 * shared core to split out.
 *
 * This file must also have exactly one export (`export default`). OpenCode's
 * plugin loader (as of 1.18.30) iterates every exported value in a plugin
 * module and invokes each one as a plugin factory, regardless of what it is
 * (a known upstream bug: https://github.com/anomalyco/opencode/issues/13543).
 * A second named export here — even a test-only helper — gets called the
 * same way and crashes every prompt. Test injection goes through the second
 * `options` argument OpenCode already passes to the plugin factory instead
 * (see `testSpawnFn` below and test/opencode.test.js).
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let spawnFn = spawn;

// Activity events refresh last_activity (caffeinate); idle/end events drop the
// session (uncaffeinate). The server's idle timeout is the real release path;
// the uncaffeinate events are belt-and-suspenders.
const ACTIVATE = new Set([
  'session.created',
  'command.executed',
  'message.updated'
]);

const DEACTIVATE = new Set(['session.idle', 'session.deleted']);

/**
 * Map an OpenCode event type to a CLI action, or null when the event is
 * irrelevant to sleep prevention.
 */
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
 * Extract the session id from an OpenCode event or a tool-execution context.
 *
 * The field carrying the id differs by event shape (confirmed against the
 * opencode-notifier / opencode-wakatime plugins):
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

/**
 * Run a CLI action, piping `{ session_id }` on stdin (the Claude Code hook
 * format). Resolves on close or error so a failed spawn never rejects a hook.
 */
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

/**
 * Build the OpenCode hooks object. `ctx` is the plugin context
 * ({ client, directory, worktree, $ }); only `directory` is used, as a fallback
 * session id when an event carries none.
 */
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

    // Tool activity is the highest-frequency signal; each call refreshes
    // last_activity so the idle timeout keeps the machine awake during a turn.
    'tool.execute.before': async input => {
      await handle('caffeinate', extractSessionId(null, input));
    },
    'tool.execute.after': async input => {
      await handle('caffeinate', extractSessionId(null, input));
    }
  };
};

// OpenCode loads this module and calls the exported plugin function with the
// plugin context, expecting a hooks object back. `options.testSpawnFn` is a
// private testing seam (see the file header comment); real OpenCode never
// sets it, so production behavior is unaffected.
const AgenticInsomnia = async (ctx, options) => {
  if (options && typeof options.testSpawnFn === 'function') {
    spawnFn = options.testSpawnFn;
  }
  return createHooks(ctx);
};

export default AgenticInsomnia;
