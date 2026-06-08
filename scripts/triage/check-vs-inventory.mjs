// A current failure that is NOT in the recovered pre-fix-#1 inventory is a
// regression introduced by fix #1 or the smell refactor.
import { readFileSync } from 'node:fs';
const norm = (s) => (s || '').replace(/\\/g, '/');

const inv = new Set();
for (const l of readFileSync('docs/triage/root-cause-inventory.jsonl', 'utf8').split('\n').filter((x) => x.trim())) {
  const r = JSON.parse(l);
  inv.add(norm(r.file) + '::' + r.test);
}

const now = new Set();
for (const fl of JSON.parse(readFileSync('.vitest-failures.json', 'utf8')).failures || [])
  for (const loc of fl.locations || []) now.add(norm(loc.file) + '::' + loc.test);

const regressions = [...now].filter((k) => !inv.has(k));
const cleared = [...inv].filter((k) => !now.has(k));
console.log('pre-fix inventory      :', inv.size);
console.log('currently failing      :', now.size);
console.log('cleared since inventory :', cleared.length);
console.log('NEW failures (regress)  :', regressions.length);
for (const r of regressions) console.log('   REGRESSION', r);
