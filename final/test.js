'use strict';
const assert = require('assert');
const fs = require('fs');
const { parseText, DEFAULT_FILTER } = require('./parser');

const RAW_LOG = process.env.P3_TEST_LOG || '/mnt/data/10.194.23.205___2026_10_08__16_23_05(1).log';
assert.strictEqual(DEFAULT_FILTER, '(ppcmd|PPort|SLPQ|pickpage|ImagePositionError|imagepositionerror|qdmg|staging|Page\\s+ID|PageId|PgSup\\s+Page)');
assert.strictEqual(new RegExp(DEFAULT_FILTER, 'i').test('ImagePositionErrorS1'), true);

if (!fs.existsSync(RAW_LOG)) {
  console.log('No real log supplied. Static-filter smoke test passed. Set P3_TEST_LOG to run the corpus assertions.');
  process.exit(0);
}

const raw = fs.readFileSync(RAW_LOG, 'utf8');
const result = parseText(raw, { maxPages: 5000, maxEvents: 50000 });
assert.ok(result.pages.length > 0, 'Expected correlated pages');
assert.ok(result.stats.matched > 0, 'Expected filter matches');

const ordered = result.pages.slice().sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
let bridgeCount = 0;
for (let i = 0; i < ordered.length - 1; i++) {
  const a = ordered[i], b = ordered[i + 1];
  if (a.stages.xfer2?.time != null && b.stages.printerEntry?.time != null) bridgeCount++;
}
assert.ok(bridgeCount > 0, 'Expected at least one 2ndXfer -> next Printer Entry transition');

const p0a = result.pages.find(p => p.pageIdHex === '0x0A');
if (p0a) {
  assert.strictEqual(p0a.start, 9076.745);
  assert.strictEqual(p0a.end, 9077.634);
  assert.strictEqual(p0a.slpq.length, 1);
  assert.strictEqual(p0a.qdmg.length, 2);
}

console.log(JSON.stringify({
  ok: true,
  filter: DEFAULT_FILTER,
  lines: result.stats.lines,
  matched: result.stats.matched,
  parsed: result.stats.parsed,
  pages: result.pages.length,
  bridges: bridgeCount,
  page0A: p0a ? { start: p0a.start, end: p0a.end, slpq: p0a.slpq.length, qdmg: p0a.qdmg.length } : null
}, null, 2));
