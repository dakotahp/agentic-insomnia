#!/usr/bin/env node

const fs = require('fs');

const {
  handleCaffeinate,
  handleToolStart,
  handleToolEnd,
  handleUncaffeinate,
  handleStatus,
  handleVersion,
  handleUsage
} = require('./src/commands');
const { handleServer } = require('./src/server');
const { stateDir } = require('./src/paths');

const main = async () => {
  fs.mkdirSync(stateDir(), { recursive: true });

  const command = process.argv[2];

  switch (command) {
  case 'caffeinate':
    await handleCaffeinate();
    break;
  case 'tool-start':
    await handleToolStart();
    break;
  case 'tool-end':
    await handleToolEnd();
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
