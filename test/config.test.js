const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const makeTempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-insomnia-config-'));
  os.homedir = () => home;
  return home;
};

const configDir = home => path.join(home, '.claude', 'plugins', 'agentic-insomnia');

test('getConfig returns defaults when no config file exists', () => {
  makeTempHome();
  delete require.cache[require.resolve('../src/config')];
  const { getConfig } = require('../src/config');

  const config = getConfig();

  assert.strictEqual(config.session_timeout_minutes, 15);
  assert.strictEqual(config.icon_theme, 'orange');
  assert.strictEqual(config.sleep_backend, 'electron');
});

test('getConfig merges user config over defaults', () => {
  const home = makeTempHome();
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ session_timeout_minutes: 30, icon_theme: 'monochrome' })
  );

  delete require.cache[require.resolve('../src/config')];
  const { getConfig } = require('../src/config');

  const config = getConfig();

  assert.strictEqual(config.session_timeout_minutes, 30);
  assert.strictEqual(config.icon_theme, 'monochrome');
});

test('getConfig falls back to defaults on invalid JSON', () => {
  const home = makeTempHome();
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');

  delete require.cache[require.resolve('../src/config')];
  const { getConfig } = require('../src/config');

  const config = getConfig();

  assert.strictEqual(config.session_timeout_minutes, 15);
  assert.strictEqual(config.icon_theme, 'orange');
});

test('getConfig caches the result across calls', () => {
  makeTempHome();
  delete require.cache[require.resolve('../src/config')];
  const { getConfig } = require('../src/config');

  const first = getConfig();
  const second = getConfig();

  assert.strictEqual(first, second);
});
