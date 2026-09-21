/**
 * Config module - Reads user configuration from config.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'plugins', 'agentic-insomnia');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  session_timeout_minutes: 15,
  idle_timeout_minutes: 30, // 0 disables
  icon_theme: 'orange', // 'orange' | 'monochrome'
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

module.exports = { getConfig };
