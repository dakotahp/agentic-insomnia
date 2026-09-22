#!/usr/bin/env node

/**
 * Regenerates the table of contents in README.md, between the toc markers.
 *
 * `npm run toc` rewrites the file. `test/readme-toc.test.js` runs the same
 * builder and fails when the committed file does not match, so the contents
 * cannot drift away from the headings.
 */

const fs = require('fs');
const path = require('path');

const README = path.join(__dirname, '..', 'README.md');
const START = '<!-- toc -->';
const END = '<!-- /toc -->';
const MIN_LEVEL = 2;
const MAX_LEVEL = 3;

/**
 * GitHub's heading anchors: lowercase, drop anything that is not a letter,
 * number, space or hyphen, then turn spaces into hyphens. An emoji is dropped
 * but the space after it is not, which is why "## 🎯 Installation" anchors to
 * "#-installation" rather than "#installation".
 */
const slugify = text =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');

/**
 * Headings outside fenced code blocks. The bash examples contain lines that
 * start with "#", so a scan that ignores fences would treat them as headings.
 */
const readHeadings = markdown => {
  const headings = [];
  let fence = null;

  for (const line of markdown.split('\n')) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) {
        fence = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fence) {
        fence = null;
      }
      continue;
    }
    if (fence) {
      continue;
    }

    const heading = line.match(/^(#{1,6}) +(.*?)#*\s*$/);
    if (!heading) {
      continue;
    }

    const level = heading[1].length;
    if (level >= MIN_LEVEL && level <= MAX_LEVEL) {
      headings.push({ level, text: heading[2].trim() });
    }
  }

  return headings;
};

const renderToc = headings =>
  headings
    .map(({ level, text }) => `${'  '.repeat(level - MIN_LEVEL)}- [${text}](#${slugify(text)})`)
    .join('\n');

/**
 * @param {string} markdown - The current README contents
 * @returns {string} The same contents with the toc block regenerated
 */
const buildToc = markdown => {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md must contain ${START} and ${END} markers, in that order`);
  }

  const body = `${START}\n\n${renderToc(readHeadings(markdown))}\n\n`;
  return markdown.slice(0, start) + body + markdown.slice(end);
};

if (require.main === module) {
  const current = fs.readFileSync(README, 'utf8');
  const updated = buildToc(current);

  if (current === updated) {
    console.error('README.md table of contents is already up to date');
  } else {
    fs.writeFileSync(README, updated);
    console.error('README.md table of contents updated');
  }
}

module.exports = { buildToc, slugify, readHeadings };
