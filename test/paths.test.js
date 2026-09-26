const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { resolveDirs } = require('../src/paths');

test('macOS and Linux use the XDG config and state folders under the home directory', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepStrictEqual(resolveDirs({ platform, env: {}, homedir: '/home/me' }), {
      config: path.join('/home/me', '.config', 'agentic-insomnia'),
      state: path.join('/home/me', '.local', 'state', 'agentic-insomnia')
    });
  }
});

test('XDG_CONFIG_HOME and XDG_STATE_HOME move the folders', () => {
  const env = { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/st' };

  assert.deepStrictEqual(resolveDirs({ platform: 'linux', env, homedir: '/home/me' }), {
    config: path.join('/cfg', 'agentic-insomnia'),
    state: path.join('/st', 'agentic-insomnia')
  });
});

test('Windows keeps config and state in LOCALAPPDATA', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

  assert.deepStrictEqual(resolveDirs({ platform: 'win32', env, homedir: 'C:\\Users\\me' }), {
    config: 'C:\\Users\\me\\AppData\\Local\\agentic-insomnia',
    state: 'C:\\Users\\me\\AppData\\Local\\agentic-insomnia'
  });
});

test('Windows falls back to AppData\\Local under the home directory', () => {
  const dirs = resolveDirs({ platform: 'win32', env: {}, homedir: 'C:\\Users\\me' });

  assert.strictEqual(dirs.state, 'C:\\Users\\me\\AppData\\Local\\agentic-insomnia');
});

test('AGENTIC_INSOMNIA_DIR overrides both folders on every OS', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const env = { AGENTIC_INSOMNIA_DIR: '/custom', XDG_STATE_HOME: '/st', LOCALAPPDATA: 'C:\\L' };

    assert.deepStrictEqual(resolveDirs({ platform, env, homedir: '/home/me' }), {
      config: '/custom',
      state: '/custom'
    });
  }
});
