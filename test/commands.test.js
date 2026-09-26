const { test } = require('node:test');
const assert = require('node:assert');

const { backendStatus } = require('../src/commands');

test('backendStatus shows the running server backend', () => {
  assert.strictEqual(backendStatus('electron', 'electron'), 'electron');
});

test('backendStatus names the configured backend when it differs from the running server', () => {
  assert.strictEqual(
    backendStatus('electron', 'native'),
    'electron (native after the server restarts)'
  );
});

test('backendStatus falls back to the configured backend when the server did not record one', () => {
  assert.strictEqual(backendStatus(null, 'native'), 'native');
});
