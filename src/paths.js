const os = require('os');
const path = require('path');

const configDir = () => path.join(os.homedir(), '.claude', 'plugins', 'agentic-insomnia');

const configPath = name => path.join(configDir(), name);

module.exports = { configDir, configPath };
