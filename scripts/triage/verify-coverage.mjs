// Verify fix-list.json covers every inventory finding exactly once (incl singletons).
import { readFileSync } from 'node:fs';
const norm = (s) => (s || '').replace(/\\/g, '/');

const inv = readFileSync('docs/triage/root-cause-inventory.jsonl', 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const invKeys = new Map();
for (const r of inv) invKeys.set(norm(r.file) + '::' + r.test, r);

const fx = JSON.parse(readFileSync('docs/triage/fix-list.json', 'utf8'));
const fxKeys = new Map();
let dup = 0;
for (const f of fx) for (const t of f.tests) {
  const k = norm(t.file) + '::' + t.test;
  if (fxKeys.has(k)) dup++;
  fxKeys.set(k, f.id);
}

const missing = [...invKeys.keys()].filter((k) => !fxKeys.has(k));
const extra = [...fxKeys.keys()].filter((k) => !invKeys.has(k));
const singletons = fx.filter((f) => f.testCount === 1);

console.log('inventory findings        :', invKeys.size);
console.log('fixes                     :', fx.length);
console.log('tests across all fixes    :', fxKeys.size, '(duplicates:', dup + ')');
console.log('sum(testCount)            :', fx.reduce((s, f) => s + f.testCount, 0));
console.log('inventory NOT in fix-list :', missing.length);
console.log('fix-list NOT in inventory :', extra.length);
console.log('single-test fixes         :', singletons.length);
for (const m of missing.slice(0, 10)) console.log('   MISSING', m);
for (const e of extra.slice(0, 10)) console.log('   EXTRA', e);
