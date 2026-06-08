// Snapshot the current vitest failing set as an EXACT regression baseline.
// Unlike the recovered inventory, this is captured directly from this run's
// .vitest-failures.json, so future checks are exact file::test diffs.
import { readFileSync, writeFileSync } from 'node:fs';
const norm = (s) => (s || '').replace(/\\/g, '/');
const keys = [];
for (const fl of JSON.parse(readFileSync('.vitest-failures.json', 'utf8')).failures || [])
  for (const loc of fl.locations || []) keys.push(norm(loc.file) + '::' + loc.test);
keys.sort();
writeFileSync('docs/triage/vitest-baseline.txt', keys.join('\n') + '\n');
console.log('wrote exact baseline:', keys.length, 'failing tests -> docs/triage/vitest-baseline.txt');
