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

const writeConfig = (home, config) => {
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
};

const loadConfig = () => {
  delete require.cache[require.resolve('../src/config')];
  return require('../src/config');
};

test('getConfig returns defaults when no config file exists', () => {
  makeTempHome();
  const { getConfig } = loadConfig();

  const config = getConfig();

  assert.strictEqual(config.stale_session_minutes, 15);
  assert.strictEqual(config.stay_awake_after_turn_minutes, 5);
  assert.strictEqual(config.server_shutdown_minutes, 30);
  assert.strictEqual(config.tray_icon_theme, 'orange');
  assert.strictEqual(config.sleep_backend, 'electron');
});

test('getConfig merges user config over defaults', () => {
  const home = makeTempHome();
  writeConfig(home, { stale_session_minutes: 30, tray_icon_theme: 'monochrome' });
  const { getConfig } = loadConfig();

  const config = getConfig();

  assert.strictEqual(config.stale_session_minutes, 30);
  assert.strictEqual(config.tray_icon_theme, 'monochrome');
});

test('getConfig falls back to defaults on invalid JSON', () => {
  const home = makeTempHome();
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');

  const { getConfig } = loadConfig();

  const config = getConfig();

  assert.strictEqual(config.stale_session_minutes, 15);
  assert.strictEqual(config.tray_icon_theme, 'orange');
});
