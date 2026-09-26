const os = require('os');
const path = require('path');

const APP = 'agentic-insomnia';

const resolveDirs = ({ platform, env, homedir }) => {
  if (env.AGENTIC_INSOMNIA_DIR) {
    return { config: env.AGENTIC_INSOMNIA_DIR, state: env.AGENTIC_INSOMNIA_DIR };
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    const dir = path.win32.join(localAppData, APP);
    return { config: dir, state: dir };
  }

  return {
    config: path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), APP),
    state: path.join(env.XDG_STATE_HOME || path.join(homedir, '.local', 'state'), APP)
  };
};

const dirs = () =>
  resolveDirs({ platform: process.platform, env: process.env, homedir: os.homedir() });

const configDir = () => dirs().config;
const stateDir = () => dirs().state;
const configPath = name => path.join(configDir(), name);
const statePath = name => path.join(stateDir(), name);

// Older versions kept config.json here, and it is still read when the new one is missing.
const legacyConfigPath = () =>
  process.env.AGENTIC_INSOMNIA_DIR
    ? null
    : path.join(os.homedir(), '.claude', 'plugins', APP, 'config.json');

module.exports = {
  resolveDirs,
  configDir,
  stateDir,
  configPath,
  statePath,
  legacyConfigPath
};
