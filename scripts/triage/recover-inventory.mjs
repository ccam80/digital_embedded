#!/usr/bin/env node
// Reconstruct test-results/root-cause-inventory.jsonl from the root-cause
// workflow's agent transcripts (test:q wiped the gitignored test-results/).
// Scans every agent-*.jsonl for `append-finding.mjs '<json>'` Bash commands and
// replays the JSON args (dedup by file::test, last wins).
//
// Usage: node scripts/triage/recover-inventory.mjs <workflow-transcript-dir>

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('need workflow transcript dir'); process.exit(1); }

function* commandsFrom(msgContent) {
  if (typeof msgContent === 'string') return;
  if (!Array.isArray(msgContent)) return;
  for (const block of msgContent) {
    if (block && block.type === 'tool_use' && block.input && typeof block.input.command === 'string') {
      yield block.input.command;
    }
  }
}

// Extract the JSON arg after append-finding.mjs, handling BOTH shell quote forms
// agents used: single-quoted '{...}' (literal) and double-quoted "{\"...\"}"
// (escaped). For double quotes we undo only the shell escapes (\" \\ \` \$) and
// preserve JSON escapes (\n \t ...).
// One occurrence: returns { json, end } where end is the index just past the
// closing quote, so the caller can scan for further append-finding calls chained
// in the same command (`append-finding ... && append-finding ...`).
function extractAt(cmd, from) {
  const i = cmd.indexOf('append-finding.mjs', from);
  if (i < 0) return null;
  let p = i + 'append-finding.mjs'.length;
  while (p < cmd.length && /\s/.test(cmd[p])) p++;
  const q = cmd[p];
  if (q === "'") {
    const end = cmd.indexOf("'", p + 1);
    return end < 0 ? { json: null, end: i + 18 } : { json: cmd.slice(p + 1, end), end: end + 1 };
  }
  if (q === '"') {
    let buf = '';
    for (let k = p + 1; k < cmd.length; k++) {
      const ch = cmd[k];
      if (ch === '\\') {
        const next = cmd[k + 1];
        if (next === '"' || next === '\\' || next === '`' || next === '$') { buf += next; k++; }
        else buf += '\\';
        continue;
      }
      if (ch === '"') return { json: buf, end: k + 1 };
      buf += ch;
    }
    return { json: null, end: cmd.length };
  }
  return { json: null, end: i + 18 };
}

function extractAll(cmd) {
  const out = [];
  let from = 0;
  while (from < cmd.length) {
    const r = extractAt(cmd, from);
    if (!r) break;
    if (r.json) out.push(r.json);
    from = r.end;
  }
  return out;
}

const byTest = new Map();
let calls = 0, parsed = 0, failed = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const content = msg?.message?.content;
    for (const cmd of commandsFrom(content)) {
      if (!cmd.includes('append-finding.mjs')) continue;
      for (const raw of extractAll(cmd)) {
        calls++;
        let rec;
        try { rec = JSON.parse(raw); } catch { failed++; continue; }
        const arr = Array.isArray(rec) ? rec : [rec];
        for (const r of arr) {
          if (!r || !r.test) continue;
          byTest.set((r.file || '') + '::' + r.test, r);
          parsed++;
        }
      }
    }
  }
}

mkdirSync(resolve('test-results'), { recursive: true });
const out = resolve('test-results/root-cause-inventory.jsonl');
writeFileSync(out, [...byTest.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`scanned append-finding calls: ${calls} | records parsed: ${parsed} | failed-extract: ${failed}`);
console.log(`unique findings recovered: ${byTest.size} -> ${out}`);
