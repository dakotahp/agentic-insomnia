#!/usr/bin/env node

const path = require('path');
const os = require('os');
const fs = require('fs');

const {
  handleCaffeinate,
  handleUncaffeinate,
  handleStatus,
  handleVersion,
  handleUsage
} = require('./src/commands');
const { handleServer } = require('./src/server');

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'plugins', 'agentic-insomnia');

const main = async () => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const command = process.argv[2];

  switch (command) {
  case 'caffeinate':
    await handleCaffeinate();
    break;
  case 'uncaffeinate':
    await handleUncaffeinate();
    break;
  case 'server':
    await handleServer();
    break;
  case 'status':
    await handleStatus();
    break;
  case 'version':
    await handleVersion();
    break;
  default:
    await handleUsage();
  }
};

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
