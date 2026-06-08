#!/usr/bin/env node
// Builds root-cause batches from the vitest failure dump, grouped to minimise
// file/category spread per batch: failing tests are kept whole-file-together and
// packed greedily up to a target size, so each agent reads as few files as
// possible. A file larger than the target gets its own (possibly oversized)
// batch rather than being split across agents.
//
// Usage: node scripts/triage/build-batches.mjs [target=10] [failures.json]
// Writes test-results/triage-batches.json and prints a summary.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = Number(process.argv[2] || 10);
const inPath = resolve(process.argv[3] || '.vitest-failures.json');

// Minimal category tagger (file-path based) so each record carries a hint; the
// authoritative taxonomy lives in classify-failures.mjs. Kept coarse on purpose.
function categoryOf(file, message) {
  const f = file.replace(/\\/g, '/');
  if (/harness\//.test(f)) return 'HARNESS/PARITY';
  if (/per-iteration divergence/.test(message)) return 'PAIR-ITER';
  if (/\bNaN\b/.test(message)) return 'NAN';
  if (/components\/.*__tests__/.test(f)) return 'COMPONENT';
  if (/solver\/analog/.test(f)) return 'ANALOG-SOLVER';
  if (/solver\/digital|components\/(pld|arithmetic|memory|flipflops)/.test(f)) return 'DIGITAL';
  return 'OTHER';
}

const data = JSON.parse(readFileSync(inPath, 'utf8'));
const failures = data.failures || [];

// Flatten to one record per failing (file, test) location.
const records = [];
for (const fl of failures) {
  for (const loc of fl.locations || []) {
    records.push({
      file: (loc.file || '').replace(/\\/g, '/'),
      test: loc.test,
      testLine: loc.line ?? null,
      message: (fl.message || '').slice(0, 200),
      category: categoryOf(loc.file || '', fl.message || ''),
    });
  }
}

// Group by file, then order files by category so adjacent files share a category.
const byFile = new Map();
for (const r of records) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}
const files = [...byFile.keys()].sort((a, b) => {
  const ca = categoryOf(a, byFile.get(a)[0].message);
  const cb = categoryOf(b, byFile.get(b)[0].message);
  return ca === cb ? a.localeCompare(b) : ca.localeCompare(cb);
});

// Greedy pack whole files into batches up to TARGET; a file bigger than TARGET
// is its own batch.
const batches = [];
let cur = [];
for (const file of files) {
  const recs = byFile.get(file);
  if (recs.length >= TARGET) {
    if (cur.length) { batches.push(cur); cur = []; }
    // Split an oversized single file into ~TARGET-sized chunks so no agent gets
    // an unbounded batch (it still reads only one file).
    for (let i = 0; i < recs.length; i += TARGET) {
      batches.push(recs.slice(i, i + TARGET));
    }
    continue;
  }
  if (cur.length + recs.length > TARGET && cur.length) {
    batches.push(cur);
    cur = [];
  }
  cur.push(...recs);
}
if (cur.length) batches.push(cur);

mkdirSync(resolve('test-results'), { recursive: true });
writeFileSync(resolve('test-results/triage-batches.json'), JSON.stringify(batches, null, 2));

console.log(`total failing (file,test) records: ${records.length}`);
console.log(`files with failures: ${byFile.size}`);
console.log(`batches: ${batches.length} (target ${TARGET}/batch)`);
batches.forEach((b, i) => {
  const cats = [...new Set(b.map((r) => r.category))].join(',');
  const fileSet = [...new Set(b.map((r) => r.file))];
  console.log(`  #${i}: ${b.length} tests | ${fileSet.length} file(s) | ${cats}`);
});
