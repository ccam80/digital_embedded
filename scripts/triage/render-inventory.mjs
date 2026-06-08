#!/usr/bin/env node
// Renders the append-only JSONL root-cause inventory into a sorted, de-duplicated
// markdown report. Last record wins per (file, test). Run after the workflow.
//
// Usage: node scripts/triage/render-inventory.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const JSONL = resolve('test-results/root-cause-inventory.jsonl');
const MD = resolve('test-results/root-cause-inventory.md');

if (!existsSync(JSONL)) {
  console.error(`no inventory at ${JSONL}`);
  process.exit(1);
}

const lines = readFileSync(JSONL, 'utf8').split('\n').filter((l) => l.trim());
const byKey = new Map();
for (const line of lines) {
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  byKey.set(`${rec.file}::${rec.test}`, rec); // last wins
}

const recs = [...byKey.values()].sort((a, b) => {
  const ca = a.category || 'zz', cb = b.category || 'zz';
  if (ca !== cb) return ca.localeCompare(cb);
  if ((a.rootCauseFile || '') !== (b.rootCauseFile || '')) return (a.rootCauseFile || '').localeCompare(b.rootCauseFile || '');
  return (a.test || '').localeCompare(b.test || '');
});

const byCat = new Map();
for (const r of recs) {
  const c = r.category || 'UNCATEGORIZED';
  if (!byCat.has(c)) byCat.set(c, []);
  byCat.get(c).push(r);
}

let md = `# Root-cause inventory\n\n`;
md += `${recs.length} unique findings across ${byCat.size} categories.\n\n`;
md += `| Category | Findings |\n|---|---:|\n`;
for (const [c, list] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
  md += `| \`${c}\` | ${list.length} |\n`;
}
md += `\n`;

for (const [c, list] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
  md += `## \`${c}\` (${list.length})\n\n`;
  md += `| Test | Root cause (file:line) | Diagnosis | Fix hint | Conf |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const r of list) {
    const rc = r.rootCauseFile ? `\`${r.rootCauseFile}:${r.rootCauseLine ?? '?'}\`` : '_(unresolved)_';
    const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
    md += `| ${esc(r.test)} | ${rc} | ${esc(r.diagnosis)} | ${esc(r.fixHint)} | ${r.confidence ?? '?'} |\n`;
  }
  md += `\n`;
}

writeFileSync(MD, md);
console.log(`rendered ${recs.length} findings -> ${MD}`);
