// For each current "true-new" failure (exact key absent from inventory), find the
// inventory entry with the same NORMALIZED name and show both side by side, so the
// character-level difference (unicode arrow, Greek tau, em-dash, apostrophe) is
// visible. If every one matches, they are recovery name-mangling, not regressions.
import { readFileSync } from 'node:fs';
const normFile = (s) => (s || '').replace(/\\/g, '/');
// Aggressive name normalization: lowercase, strip all non-alphanumerics.
const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const inv = readFileSync('docs/triage/root-cause-inventory.jsonl', 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const invByKey = new Set(inv.map((r) => normFile(r.file) + '::' + r.test));
const invByNorm = new Map(); // normalized(file)+normalized(test) -> raw entry
for (const r of inv) invByNorm.set(normFile(r.file) + '##' + normName(r.test), r);

const now = [];
for (const fl of JSON.parse(readFileSync('.vitest-failures.json', 'utf8')).failures || [])
  for (const loc of fl.locations || []) now.push({ file: normFile(loc.file), test: loc.test });

const trueNew = now.filter((x) => !invByKey.has(x.file + '::' + x.test));
let matched = 0, unmatched = 0;
for (const t of trueNew) {
  const hit = invByNorm.get(t.file + '##' + normName(t.test));
  if (hit) {
    matched++;
    console.log('MATCH  ' + t.file.split('/').pop());
    console.log('   current  : ' + JSON.stringify(t.test));
    console.log('   inventory: ' + JSON.stringify(hit.test));
  } else {
    unmatched++;
    console.log('NO-MATCH (possible real regression): ' + t.file + ' :: ' + t.test);
  }
}
console.log(`\n${trueNew.length} true-new -> ${matched} matched to inventory by normalized name, ${unmatched} unmatched`);
