const fs = require('fs');
const { configDir, configPath, legacyConfigPath } = require('./paths');

const configFile = () => configPath('config.json');
const exampleConfigFile = () => configPath('config.example.json');

const readableConfigFile = () =>
  [configFile(), legacyConfigPath()].find(file => file && fs.existsSync(file));

const DEFAULTS = {
  stay_awake_after_turn_minutes: 5, // 0 disables
  stale_session_minutes: 15,
  long_tool_call_minutes: 120,
  server_shutdown_minutes: 30, // 0 disables
  tray_icon_theme: 'orange', // 'orange' | 'monochrome'
  sleep_backend: 'auto' // 'auto' | 'native' | 'electron'
};

let cachedConfig = null;

const getConfig = () => {
  if (cachedConfig) {
    return cachedConfig;
  }

  let userConfig = {};
  try {
    const file = readableConfigFile();
    if (file) {
      userConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (error) {
    console.error('Warning: Failed to read config file, using defaults:', error.message);
  }

  cachedConfig = { ...DEFAULTS, ...userConfig };
  return cachedConfig;
};

// Generated from DEFAULTS rather than shipped as a file, so it cannot drift when
// a setting is added or renamed.
const writeExampleConfig = () => {
  const file = readableConfigFile();
  if (file && file === legacyConfigPath()) {
    console.error(`Using ${legacyConfigPath()}. Move it to ${configFile()}.`);
  }

  const contents = `${JSON.stringify(DEFAULTS, null, 2)}\n`;

  try {
    if (fs.readFileSync(exampleConfigFile(), 'utf8') === contents) {
      return;
    }
  } catch {
    // Missing or unreadable, so write it.
  }

  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(exampleConfigFile(), contents);
  } catch (error) {
    console.error('Warning: Failed to write config.example.json:', error.message);
  }
};

module.exports = { getConfig, writeExampleConfig };
