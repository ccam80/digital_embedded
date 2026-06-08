// Diagnostic: print the append-finding commands that fail to extract/parse.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];

function* commandsFrom(c) {
  if (!Array.isArray(c)) return;
  for (const b of c) if (b && b.type === 'tool_use' && b.input && typeof b.input.command === 'string') yield b.input.command;
}
function extractJson(cmd) {
  const i = cmd.indexOf('append-finding.mjs'); if (i < 0) return null;
  const rest = cmd.slice(i); const start = rest.search(/[{[]/); if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < rest.length; k++) {
    const ch = rest[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return rest.slice(start, k + 1); }
  }
  return null;
}
let shown = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    for (const cmd of commandsFrom(m?.message?.content)) {
      if (!cmd.includes('append-finding.mjs')) continue;
      const raw = extractJson(cmd);
      let ok = false;
      if (raw) { try { JSON.parse(raw); ok = true; } catch {} }
      if (!ok && shown < 6) {
        shown++;
        console.log('===== FAIL #' + shown + ' (' + f.slice(0, 18) + ') extracted=' + (raw ? 'yes' : 'NULL') + ' =====');
        console.log(cmd.slice(0, 700));
        console.log();
      }
    }
  }
}
console.log('shown', shown);
