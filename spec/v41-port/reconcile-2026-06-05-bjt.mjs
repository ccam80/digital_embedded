#!/usr/bin/env node
/* reconcile-2026-06-05-bjt.mjs — flip the bjt quasi-saturation recon APPLIED.
 *
 * bjt (full Gummel-Poon + Kull quasi-saturation + the v41 TLEV/TLEVC temperature
 * subsystem + the v41 AC stamp) is now harness-gated bit-exact across every
 * surface and every acceptance device (Part 9 / acceptance #8 of the recon):
 *   - npn-ce-full   (classic-GP control, all three pins off-ground)  127/127
 *   - npn-ce                                                          118/118
 *   - pnp-cc        (collector grounded)                             118/118
 *   - bjt-quasisat  (Kull-active, rco/vo/gamma/qco/quasimod)          127/127
 *   - bjt-tlev      (tlev=3, tlevc=1, tempco, TNOM-shifted dt=-50)    127/127
 *   - npn-ce-full AC                                                  91/91 null
 *   - DC-OP solution + limiting events                               bit-exact
 * Narrow parity suite (harness + ngspice-parity): 311 passed / 0 failed.
 *
 * Fixes that brought it bit-exact this session: NKF roll-off branch keyed off
 * the given-flag (not the value); gbcx no longer persisted to state; limiting
 * events recorded only when pnjlim runs (init-seed gate); substrate limiting
 * event labelled "CS" to match ngspice junction-8.
 *
 * Records the bjt recon + the bjt delta hunks APPLIED. Edits progress.json;
 * the ledger is regenerated after via build-ledger.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const ledger = readJ(join(HERE, 'ledger.json'));
const byId = new Map(ledger.items.map((i) => [i.id, i]));
const unitOf = (it) => basename(it.diffDoc ?? 'NULLDOC', '.md');
const DATE = '2026-06-05';
const log = [];

const PROG = join(HERE, 'progress.json');
const prog = readJ(PROG); prog.items = prog.items ?? {};
function applied(id, note) {
  const it = byId.get(id);
  if (!it) { log.push(`WARN no ledger item ${id} — skipped`); return; }
  prog.items[id] = {
    state: 'APPLIED', hunkHash: it.hunkHash,
    attempts: (prog.items[id]?.attempts ?? 1), verifierNotes: [note], escalation: null,
  };
  log.push(`APPLIED  ${id}  (was ${it.state})`);
}

const note = `Gate-verified bit-exact ${DATE}: harness firstDivergence/acFirstDivergence null across npn-ce-full / npn-ce / pnp-cc / bjt-quasisat (Kull) / bjt-tlev (tlev=3,tlevc=1,dt=-50) transient + DC-OP (solution + limiting events) + AC; narrow parity suite 311/311. Acceptance #8 three-device coverage met; all three pins exercised off-ground (npn-ce-full).`;
for (const it of ledger.items) {
  if (it.state !== 'PENDING') continue;
  if (unitOf(it) === 'bjt' || it.id.startsWith('bjt')) applied(it.id, note);
}

writeJ(PROG, prog);
console.log('=== reconcile-2026-06-05-bjt ===');
for (const l of log) console.log('  ' + l);
console.log(`\n  total recorded: ${log.filter((l) => l.startsWith('APPLIED')).length}`);
