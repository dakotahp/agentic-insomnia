const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const readJson = relative =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'));

const hooks = readJson('hooks/hooks.json');
const codexManifest = readJson('plugin.json');
const claudeManifest = readJson('.claude-plugin/plugin.json');
const pkg = readJson('package.json');

// Events Codex does not define. The shared hook file uses none of these today;
// the allowlist exists so that adding a Claude-only hook later is a deliberate
// choice rather than a hook that silently never fires under Codex.
const CLAUDE_ONLY_EVENTS = new Set(['Notification']);

// Every event the shared hook file may declare, minus the Claude-only ones,
// must exist in Codex. Codex's list is fixed, so pin it here: a new hook on an
// event Codex does not know would silently never fire there.
const CODEX_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'Interrupt',
  'PermissionRequest'
]);

const eachHookCommand = visit => {
  for (const [event, matchers] of Object.entries(hooks.hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        visit(event, hook);
      }
    }
  }
};

test('every hook command runs the bundled CLI through the plugin root', () => {
  eachHookCommand((event, hook) => {
    assert.strictEqual(hook.type, 'command', `${event} hook must be a command hook`);
    assert.match(
      hook.command,
      /\$\{CLAUDE_PLUGIN_ROOT\}\/caffeine\.js/,
      `${event} hook must call the bundled caffeine.js via the plugin root`
    );
  });
});

test('every hook command ends in a known CLI action', () => {
  eachHookCommand((event, hook) => {
    const action = hook.command.trim().split(/\s+/).pop();
    assert.ok(
      action === 'caffeinate' || action === 'uncaffeinate',
      `${event} hook runs unknown action "${action}"`
    );
  });
});

test('shared hook events are portable to Codex, except the documented Claude-only ones', () => {
  for (const event of Object.keys(hooks.hooks)) {
    if (CLAUDE_ONLY_EVENTS.has(event)) {
      continue;
    }
    assert.ok(
      CODEX_EVENTS.has(event),
      `${event} is not a Codex event; add it to CLAUDE_ONLY_EVENTS if that is intentional`
    );
  }
});

test('Codex manifest points at the shared hook file', () => {
  const hooksPath = codexManifest.extensions['com.openai'].hooks;
  assert.strictEqual(hooksPath, './hooks/hooks.json');
  assert.ok(fs.existsSync(path.join(__dirname, '..', hooksPath)));
});

test('both plugin manifests carry the package version', () => {
  assert.strictEqual(codexManifest.version, pkg.version);
  assert.strictEqual(claudeManifest.version, pkg.version);
});

test('both plugin manifests use the same plugin name', () => {
  assert.strictEqual(codexManifest.name, pkg.name);
  assert.strictEqual(claudeManifest.name, pkg.name);
});

test('the Codex marketplace lists the plugin with a complete policy', () => {
  const marketplace = readJson('.agents/plugins/marketplace.json');
  const entry = marketplace.plugins.find(plugin => plugin.name === pkg.name);

  assert.ok(entry, 'marketplace must list agentic-insomnia');
  assert.ok(entry.category, 'Codex requires category on each plugin entry');
  assert.ok(entry.policy.installation, 'Codex requires policy.installation');
  assert.ok(entry.policy.authentication, 'Codex requires policy.authentication');
});
