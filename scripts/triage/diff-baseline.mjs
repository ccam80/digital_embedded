// Exact diff of current vitest failures against the snapshotted 191 baseline.
import { readFileSync } from 'node:fs';
const norm = (s) => (s || '').replace(/\\/g, '/');
const base = new Set(readFileSync('docs/triage/vitest-baseline.txt', 'utf8').split('\n').filter((l) => l.trim()));
const now = new Set();
for (const fl of JSON.parse(readFileSync('.vitest-failures.json', 'utf8')).failures || [])
  for (const loc of fl.locations || []) now.add(norm(loc.file) + '::' + loc.test);
const newFail = [...now].filter((k) => !base.has(k));
const fixed = [...base].filter((k) => !now.has(k));
console.log('baseline:', base.size, ' current:', now.size);
console.log('NEW failures (regressions):', newFail.length);
for (const k of newFail) console.log('   + ' + k);
console.log('newly PASSING (fixed):', fixed.length);
for (const k of fixed) console.log('   - ' + k);
