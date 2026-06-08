#!/usr/bin/env node
// Reconstruct the pre-fix failing-test baseline (the wiped triage-batches.json)
// from the root-cause workflow transcripts: each agent printed its batch via
// `node -e "...require(triage-batches.json)[i]..."`, so the batch arrays survive
// as tool_result stdout. Collect every record (file,test,...) and dedup.
//
// Usage: node scripts/triage/recover-baseline.mjs <workflow-transcript-dir>
// Writes test-results/triage-batches.json as a single batch of all baseline tests.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('need workflow transcript dir'); process.exit(1); }

function* strings(content) {
  if (typeof content === 'string') { yield content; return; }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (typeof b === 'string') yield b;
    else if (b && typeof b.content === 'string') yield b.content;
    else if (b && Array.isArray(b.content)) for (const c of b.content) if (c && typeof c.text === 'string') yield c.text;
    else if (b && typeof b.text === 'string') yield b.text;
  }
}

const byTest = new Map();
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    for (const s of strings(msg?.message?.content)) {
      if (!s.includes('"test"') || !s.includes('"category"')) continue;
      // find JSON array(s) in the string
      const start = s.indexOf('[');
      if (start < 0) continue;
      let arr;
      try { arr = JSON.parse(s.slice(start, s.lastIndexOf(']') + 1)); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const r of arr) {
        if (r && r.test && r.file) byTest.set((r.file || '').replace(/\\/g, '/') + '::' + r.test, r);
      }
    }
  }
}

mkdirSync(resolve('test-results'), { recursive: true });
writeFileSync(resolve('test-results/triage-batches.json'), JSON.stringify([[...byTest.values()]], null, 2));
console.log(`recovered baseline failing tests: ${byTest.size} -> test-results/triage-batches.json`);
