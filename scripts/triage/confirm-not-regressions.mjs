// For each current failure whose file::test key is absent from the inventory,
// check whether its TEST NAME alone appears in the inventory. If so it is a
// recovered-key/file-name mismatch, not a real regression.
import { readFileSync } from 'node:fs';
const norm = (s) => (s || '').replace(/\\/g, '/');

const invKeys = new Set();
const invNames = new Set();
for (const l of readFileSync('docs/triage/root-cause-inventory.jsonl', 'utf8').split('\n').filter((x) => x.trim())) {
  const r = JSON.parse(l);
  invKeys.add(norm(r.file) + '::' + r.test);
  invNames.add(r.test);
}

const now = [];
for (const fl of JSON.parse(readFileSync('.vitest-failures.json', 'utf8')).failures || [])
  for (const loc of fl.locations || []) now.push({ key: norm(loc.file) + '::' + loc.test, test: loc.test });

const notByKey = now.filter((x) => !invKeys.has(x.key));
const nameMatched = notByKey.filter((x) => invNames.has(x.test));
const trueNew = notByKey.filter((x) => !invNames.has(x.test));

console.log('current failures not matched by file::test :', notByKey.length);
console.log('  ...but test NAME is in inventory (mismatch):', nameMatched.length);
console.log('  ...genuinely absent (real new failures)    :', trueNew.length);
for (const t of trueNew) console.log('   TRUE-NEW', t.key);
