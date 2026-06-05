#!/usr/bin/env node
/* reconcile-2026-06-05-asrc.mjs — flip the asrc object APPLIED.
 *
 * asrc (BV/BI behavioural B-source + the IFeval expression engine) is now
 * harness-gated bit-exact across every analysis path on two fixtures
 * (asrc-bsource-gate.dts, asrc-bsource-ac-gate.dts):
 *   - DC-OP, branch controller I(Vin)      firstDivergence null, 4/4 iters
 *   - DC-OP, node controller V(mid)+findNode firstDivergence null, 3/3 iters
 *   - AC Jacobian (stampAc)                  acFirstDivergence null, 61/61 pts
 *   - transient (MODETRAN + srcFact ramp)    firstDivergence null, 107/107 steps
 * The AC reload was wired under the wrong method name (stampAcJacobian vs the
 * engine's stampAc); corrected to the vsrc-style stampAc signature. Records the
 * recon + the asrc delta hunks APPLIED. Edits progress.json; ledger regenerates.
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

const note = `Gate-verified bit-exact ${DATE}: asrc-bsource-gate.dts + asrc-bsource-ac-gate.dts, harness firstDivergence/acFirstDivergence null across DC-OP (branch + node controllers), AC (stampAc), and transient; ours/ngspice iteration counts identical. stampAc method-name/signature corrected to the vsrc-style contract.`;
for (const it of ledger.items) {
  if (it.state !== 'PENDING') continue;
  if (unitOf(it) === 'asrc' || it.id.startsWith('asrc')) applied(it.id, note);
}

writeJ(PROG, prog);
console.log('=== reconcile-2026-06-05-asrc ===');
for (const l of log) console.log('  ' + l);
console.log(`\n  total recorded: ${log.filter((l) => l.startsWith('APPLIED')).length}`);
