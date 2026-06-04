#!/usr/bin/env node
/* reconcile-2026-06-05-burst.mjs — record the device-gate burst.
 *
 * Every device below was harness-gated bit-exact this session: firstDivergence
 * null across all signal classes, ours/ngspice iteration counts identical. The
 * v41 deltas are already in the code (built in prior sessions / the wholeClass
 * recons); this records the PENDING delta hunks APPLIED now that each device's
 * gate is confirmed green. Also:
 *   - mos1#recon/stampAc: AC-gated bit-exact (harness_run_ac, acFirstDivergence
 *     null over 91 points 1Hz-1GHz) — unblocks mos1/mos1acld.c#h001.
 *   - dio/dioconv.c#h002: the escalation is resolved — the root cause was the
 *     niConvTest row-coverage bug (newton-raphson.ts), now fixed to the
 *     niconv.c:39 form; diode-canon-cap-rc.dts gates null. De-escalate.
 * Edits progress.json only; ledger is regenerated after via build-ledger.mjs.
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

// --- device-delta hunks: gate-verified bit-exact this session ---
const DEVICE_GATES = {
  csw: 'csw-gate.dts', jfet2: 'jfet2-gate.dts', mos3: 'mos3-gate.dts',
  mes: 'mes-gate.dts', mos1: 'mosfet-inverter.dts', sw: 'sw-gate.dts',
};
for (const [unit, fix] of Object.entries(DEVICE_GATES)) {
  const note = `Gate-verified bit-exact ${DATE}: harness firstDivergence null (all signal classes) on ${fix}, ours/ngspice iteration counts identical. v41 delta present in code.`;
  for (const it of ledger.items) {
    if (it.kind !== 'hunk' || it.state !== 'PENDING' || unitOf(it) !== unit) continue;
    // a hunk blocked by an un-applied recon stays PENDING — except the one this
    // run is applying (mos1#recon/stampAc), which unblocks mos1acld.c#h001.
    if (it.blockedBy && it.blockedBy !== 'mos1#recon/stampAc'
        && byId.get(it.blockedBy)?.state !== 'APPLIED') continue;
    applied(it.id, note);
  }
}

// --- mos1 AC stamp reconstruction: AC-gate verified ---
applied('mos1#recon/stampAc',
  `AC-gate verified bit-exact ${DATE}: harness_run_ac on mosfet-inverter.dts, acFirstDivergence null (solution/matrix/rhs/shape) across 91 points 1Hz-1GHz. MosfetAnalogElement.stampAc (mosfet.ts) verified line-for-line against mos1acld.c.`);

// --- dio NR escalation resolved ---
applied('dio/dioconv.c#h002',
  `Escalation resolved ${DATE}: root cause was niConvTest skipping the highest MNA row (newton-raphson.ts looped [0,size) over the 1-based MNA, omitting the last branch/current row), fixed to the niconv.c:39 form (loop 1..size, tol classified by nodeType). diode-canon-cap-rc.dts now firstDivergence null 123/123, iteration counts match ngspice. The fix is a faithful niconv.c port — dioconv.c itself was already at v41.`);

writeJ(PROG, prog);
console.log('=== reconcile-2026-06-05-burst ===');
for (const l of log) console.log('  ' + l);
console.log(`\n  total recorded: ${log.filter((l) => l.startsWith('APPLIED')).length}`);
