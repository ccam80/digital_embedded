#!/usr/bin/env node
// Append-only writer for the root-cause inventory. Agents call this once per
// finding so concurrent workflow agents never corrupt the file: each invocation
// appends exactly one self-contained JSON line (JSONL), which is atomic for the
// small record sizes involved.
//
// Usage:
//   node scripts/triage/append-finding.mjs '<json-object-or-array>'
//
// Record shape (fields beyond `test` optional but expected):
//   {
//     "test":          "<test name>",            // required
//     "file":          "src/.../foo.test.ts",    // test file
//     "testLine":      123,                        // assertion line
//     "category":      "ENGINE_NUM",              // triage category code
//     "rootCauseFile": "src/.../bar.ts",          // file with the bug
//     "rootCauseLine": 456,                        // the incorrect line
//     "diagnosis":     "one-line root cause",
//     "fixHint":       "what the line should do",
//     "confidence":    "high|medium|low"
//   }

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('test-results/root-cause-inventory.jsonl');

const raw = process.argv[2];
if (!raw || !raw.trim()) {
  console.error('append-finding: no JSON provided as argv[2]');
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error('append-finding: invalid JSON:', e.message);
  process.exit(1);
}

const records = Array.isArray(parsed) ? parsed : [parsed];
mkdirSync(resolve('test-results'), { recursive: true });

let n = 0;
for (const rec of records) {
  if (!rec || typeof rec !== 'object' || !rec.test) {
    console.error('append-finding: record missing `test`, skipping:', JSON.stringify(rec));
    continue;
  }
  const stamped = { ...rec, ts: new Date().toISOString() };
  appendFileSync(OUT, JSON.stringify(stamped) + '\n', 'utf8');
  n++;
}
console.log(`append-finding: wrote ${n} record(s) to ${OUT}`);
