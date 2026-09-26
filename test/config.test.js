const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Without the override, the real folder rules apply, pointed inside the temp home.
const makeTempHome = ({ override = true } = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-insomnia-config-'));
  os.homedir = () => home;
  if (override) {
    process.env.AGENTIC_INSOMNIA_DIR = path.join(home, 'data');
  } else {
    delete process.env.AGENTIC_INSOMNIA_DIR;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
    process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  }
  return home;
};

const configDir = () => require('../src/paths').configDir();

const legacyDir = home => path.join(home, '.claude', 'plugins', 'agentic-insomnia');

const writeConfig = (home, config) => {
  const dir = configDir();
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
  assert.strictEqual(config.sleep_backend, 'auto');
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
  makeTempHome();
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');

  const { getConfig } = loadConfig();

  const config = getConfig();

  assert.strictEqual(config.stale_session_minutes, 15);
  assert.strictEqual(config.tray_icon_theme, 'orange');
});

const exampleFile = () => path.join(configDir(), 'config.example.json');

test('writeExampleConfig writes every setting at its default', () => {
  makeTempHome();
  const { writeExampleConfig, getConfig } = loadConfig();

  writeExampleConfig();

  const example = JSON.parse(fs.readFileSync(exampleFile(), 'utf8'));
  assert.deepStrictEqual(example, getConfig());
});

test('writeExampleConfig never creates or touches config.json', () => {
  const home = makeTempHome();
  writeConfig(home, { stale_session_minutes: 42 });
  const { writeExampleConfig } = loadConfig();

  writeExampleConfig();

  const config = JSON.parse(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf8'));
  assert.deepStrictEqual(config, { stale_session_minutes: 42 });
});

test('writeExampleConfig refreshes an example left over from older defaults', () => {
  makeTempHome();
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(exampleFile(), '{"idle_timeout_minutes": 30}');
  const { writeExampleConfig } = loadConfig();

  writeExampleConfig();

  const example = JSON.parse(fs.readFileSync(exampleFile(), 'utf8'));
  assert.strictEqual(example.idle_timeout_minutes, undefined);
  assert.strictEqual(example.server_shutdown_minutes, 30);
});

test('writeExampleConfig does not throw when the config directory cannot be created', () => {
  const home = makeTempHome();
  fs.writeFileSync(path.join(home, 'data'), 'not a directory');
  const { writeExampleConfig } = loadConfig();

  assert.doesNotThrow(() => writeExampleConfig());
});

const writeLegacyConfig = (home, config) => {
  fs.mkdirSync(legacyDir(home), { recursive: true });
  fs.writeFileSync(path.join(legacyDir(home), 'config.json'), JSON.stringify(config));
};

test('getConfig reads config.json from the old folder when the new one has none', () => {
  const home = makeTempHome({ override: false });
  writeLegacyConfig(home, { stale_session_minutes: 42 });
  const { getConfig } = loadConfig();

  assert.strictEqual(getConfig().stale_session_minutes, 42);
});

test('getConfig prefers config.json in the new folder over the old one', () => {
  const home = makeTempHome({ override: false });
  writeLegacyConfig(home, { stale_session_minutes: 42 });
  writeConfig(home, { stale_session_minutes: 7 });
  const { getConfig } = loadConfig();

  assert.strictEqual(getConfig().stale_session_minutes, 7);
});

test('writeExampleConfig tells the user to move a config.json from the old folder', t => {
  const errors = t.mock.method(console, 'error', () => {});
  const home = makeTempHome({ override: false });
  writeLegacyConfig(home, {});
  const { writeExampleConfig } = loadConfig();

  writeExampleConfig();

  assert.match(errors.mock.calls[0].arguments[0], /Move it to/);
});

test('AGENTIC_INSOMNIA_DIR ignores config.json in the old folder', () => {
  const home = makeTempHome();
  writeLegacyConfig(home, { stale_session_minutes: 42 });
  const { getConfig } = loadConfig();

  assert.strictEqual(getConfig().stale_session_minutes, 15);
});
