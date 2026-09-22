const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildToc, slugify, readHeadings } = require('../scripts/generate-toc');

const README = path.join(__dirname, '..', 'README.md');

// Compare only the block between the markers. Asserting on the whole file would
// print the entire README on failure and bury the one line that differs.
const tocBlock = markdown =>
  markdown.slice(markdown.indexOf('<!-- toc -->'), markdown.indexOf('<!-- /toc -->'));

test('the README table of contents matches its headings', () => {
  const current = fs.readFileSync(README, 'utf8');

  assert.strictEqual(
    tocBlock(current),
    tocBlock(buildToc(current)),
    'README.md table of contents is stale. Run `npm run toc` and commit the result.'
  );
});

test('slugify matches how GitHub builds heading anchors', () => {
  assert.strictEqual(slugify('Features'), 'features');
  assert.strictEqual(slugify('Switching to the native backend'), 'switching-to-the-native-backend');
  // The emoji is dropped but the space after it is not, so the anchor keeps a leading hyphen.
  assert.strictEqual(slugify('🎯 Installation'), '-installation');
  assert.strictEqual(slugify('⚙️ Configuration (Optional)'), '-configuration-optional');
});

test('readHeadings ignores comment lines inside fenced code blocks', () => {
  const markdown = [
    '## Real heading',
    '',
    '```bash',
    '# Start server + system tray',
    '```',
    '',
    '### Another real heading'
  ].join('\n');

  assert.deepStrictEqual(readHeadings(markdown), [
    { level: 2, text: 'Real heading' },
    { level: 3, text: 'Another real heading' }
  ]);
});

test('every table of contents link points at a heading in the file', () => {
  const current = fs.readFileSync(README, 'utf8');
  const anchors = new Set(readHeadings(current).map(heading => `#${slugify(heading.text)}`));

  const toc = current.slice(current.indexOf('<!-- toc -->'), current.indexOf('<!-- /toc -->'));
  const links = [...toc.matchAll(/\]\((#[^)]*)\)/g)].map(match => match[1]);

  assert.ok(links.length > 0, 'expected the table of contents to contain links');
  for (const link of links) {
    assert.ok(anchors.has(link), `table of contents links to ${link}, which is not a heading`);
  }
});

test('in-page links outside the table of contents point at real headings', () => {
  const current = fs.readFileSync(README, 'utf8');
  const anchors = new Set(readHeadings(current).map(heading => `#${slugify(heading.text)}`));

  const body = current.slice(current.indexOf('<!-- /toc -->'));
  const links = [...body.matchAll(/\]\((#[^)]*)\)/g)].map(match => match[1]);

  for (const link of links) {
    assert.ok(anchors.has(link), `README links to ${link}, which is not a heading`);
  }
});
