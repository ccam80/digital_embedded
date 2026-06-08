// Compare the current .vitest-failures.json against the failing-test baseline
// captured in triage-batches.json. Reports cleared, still-failing, and NEW
// (regression) tests. Key = file::test.
import { readFileSync } from 'node:fs';

const norm = (s) => (s || '').replace(/\\/g, '/');

const baseline = new Set();
for (const b of JSON.parse(readFileSync('test-results/triage-batches.json', 'utf8')))
  for (const r of b) baseline.add(norm(r.file) + '::' + r.test);

const now = new Set();
for (const fl of JSON.parse(readFileSync('.vitest-failures.json', 'utf8')).failures || [])
  for (const loc of fl.locations || []) now.add(norm(loc.file) + '::' + loc.test);

const cleared = [...baseline].filter((k) => !now.has(k));
const stillFailing = [...baseline].filter((k) => now.has(k));
const regressions = [...now].filter((k) => !baseline.has(k));

console.log('baseline failing :', baseline.size);
console.log('now failing      :', now.size);
console.log('cleared          :', cleared.length);
console.log('still failing    :', stillFailing.length);
console.log('NEW (regressions):', regressions.length);
for (const r of regressions) console.log('   REGRESSION', r);
