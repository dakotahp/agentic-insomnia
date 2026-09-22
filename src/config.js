/**
 * Config module - Reads user configuration from config.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'plugins', 'agentic-insomnia');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const EXAMPLE_CONFIG_FILE = path.join(CONFIG_DIR, 'config.example.json');

const DEFAULTS = {
  stay_awake_after_turn_minutes: 5, // 0 disables
  stale_session_minutes: 15,
  server_shutdown_minutes: 30, // 0 disables
  tray_icon_theme: 'orange', // 'orange' | 'monochrome'
  sleep_backend: 'electron' // 'electron' | 'native'
};

let cachedConfig = null;

const getConfig = () => {
  if (cachedConfig) {
    return cachedConfig;
  }

  let userConfig = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Warning: Failed to read config file, using defaults:', error.message);
  }

  cachedConfig = { ...DEFAULTS, ...userConfig };
  return cachedConfig;
};

/**
 * Write config.example.json next to config.json, so every setting and its default
 * is discoverable without checking out this repo. Generated from DEFAULTS rather
 * than shipped as a file, so it cannot drift when a setting is added or renamed.
 * Never reads or writes config.json.
 */
const writeExampleConfig = () => {
  const contents = `${JSON.stringify(DEFAULTS, null, 2)}\n`;

  try {
    if (fs.readFileSync(EXAMPLE_CONFIG_FILE, 'utf8') === contents) {
      return;
    }
  } catch {
    // Missing or unreadable: fall through and write it.
  }

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(EXAMPLE_CONFIG_FILE, contents);
  } catch (error) {
    console.error('Warning: Failed to write config.example.json:', error.message);
  }
};

module.exports = { getConfig, writeExampleConfig };
