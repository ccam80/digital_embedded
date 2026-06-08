// One-off: report root-cause inventory coverage vs the failing-test batches.
import { readFileSync } from 'node:fs';

const norm = (s) => (s || '').replace(/\\/g, '/');
const batches = JSON.parse(readFileSync('test-results/triage-batches.json', 'utf8'));
const wanted = new Map();
for (const b of batches) for (const r of b) wanted.set(norm(r.file) + '::' + r.test, r);

const recs = readFileSync('test-results/root-cause-inventory.jsonl', 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const found = new Map();
for (const r of recs) found.set(norm(r.file) + '::' + r.test, r);

let resolved = 0, unresolved = 0;
for (const r of found.values()) {
  if (r.rootCauseLine == null || r.rootCauseFile == null) unresolved++; else resolved++;
}
console.log('failing tests (batched):', wanted.size);
console.log('unique findings:', found.size);
console.log('  resolved (line cited):', resolved, '| unresolved (null):', unresolved);

const missed = [];
for (const k of wanted.keys()) if (!found.has(k)) missed.push(k);
console.log('wanted-but-no-exact-finding:', missed.length);
for (const m of missed.slice(0, 30)) console.log('   MISS', m);
