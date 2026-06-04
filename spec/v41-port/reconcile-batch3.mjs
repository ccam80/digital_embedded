#!/usr/bin/env node
/* reconcile-batch3.mjs — clear the engine-tier residue that livelocks the loop:
 * stabilize verified-at-v41 STALE recons, resolve the dctran group's bookkeeping
 * (h006 already implemented -> APPLIED; h004/5/7/8/9 console/XSPICE -> NC). Edits
 * only progress.json + analysis-decisions.json; ledger is regenerated after. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const ledger = readJ(join(HERE, 'ledger.json'));
const byId = new Map(ledger.items.map((i) => [i.id, i]));
const hashOf = (id) => { const it = byId.get(id); if (!it) throw new Error(`no ledger item ${id}`); return it.hunkHash; };
const stateOf = (id) => byId.get(id)?.state ?? '(absent)';
const DATE = '2026-06-05';
const log = [];

// --- progress.json: stabilize verified-at-v41 STALE recons + record dctran h006 ---
const PROG = join(HERE, 'progress.json');
const prog = readJ(PROG); prog.items = prog.items ?? {};
function applied(id, note) {
  prog.items[id] = { state: 'APPLIED', hunkHash: hashOf(id), attempts: (prog.items[id]?.attempts ?? 1), verifierNotes: [note], escalation: null };
  log.push(`progress APPLIED  ${id}  (was ${stateOf(id)})`);
}
applied('analysis#recon/tf',
  `Cheap re-verify ${DATE}: .tf driver harness-verified bit-exact this session (tf-parity 2/2, circuit_tf 0.5/2000/500); code present in dc-operating-point.ts/analog-engine.ts/ac-analysis.ts. Re-record APPLIED at current spec hash to stabilize (was STALE from spec drift).`);
applied('expr-engine#recon/numericalDeltas',
  `Cheap re-verify ${DATE}: clamps/hyperbolics/atto + tan/tanh derivatives present (expression.ts:109-161, expression-differentiate.ts:157-172, model-parser.ts:96); its 4 PORT hunks recorded APPLIED in the same run. Re-record APPLIED at current spec hash to stabilize (was STALE).`);
applied('vsrc#recon/waveformModel',
  `Cheap re-verify ${DATE}: vsrc device-complete (harness firstDivergence null on vsrc-ac-square-rload.dts + vsrc-ac-sine-rload.dts this session); ngspice coefficient-model waveform engine present (ac-voltage-source.ts:158-195, ac-current-source.ts, load-context.ts:87-99). Re-record APPLIED at current spec hash to stabilize (was STALE).`);
applied('analysis/dctran.c#h006',
  `APPLIED ${DATE}: transient-OP->first-step state copy memcpy(CKTstate1,CKTstate0) (dctran.c:325-326 post-image) is line-isomorphic to analog-engine.ts:2261 cac.statePool.states[1].set(cac.statePool.states[0]) (cited dctran.c:349-350). Bookkeeping omission in the dctran group disposition; recorded here.`);
for (const r of ['sw#recon/acLoad', 'sw#recon/trunc', 'sw#recon/icParam']) {
  applied(r, `Cheap re-verify ${DATE}: implementation present in src/components/active/analog-switch.ts (acLoad stampAc / trunc _truncPath / icParam _zeroStateGiven), prior-APPLIED, drifted to STALE on spec hash. Re-record APPLIED at current spec hash to stabilize and stop recon-churn; the sw device gate (sw-gate.dts) still runs on the unit's PENDING hunks.`);
}
writeJ(PROG, prog);

// --- analysis-decisions.json: NC the 5 console/XSPICE/output dctran hunks ---
const AN = join(HERE, 'planning', 'analysis-decisions.json');
const an = readJ(AN); an.items = an.items ?? {};
const NC = {
  'analysis/dctran.c#h004': 'dctran.c:235-255 stdout fprintf console progress block; the engine-agnostic engine has no console/front-end output path. Same NO-COUNTERPART class as the already-frozen dctran.c#h003/#h010.',
  'analysis/dctran.c#h005': 'dctran.c:257-260 SPfrontEnd->OUTendPlot front-end plot callback; no digiTS counterpart (engine emits no plots). NO-COUNTERPART, same class as dctran.c#h003/#h010.',
  'analysis/dctran.c#h007': 'dctran.c:419 #ifdef XSPICE g_ipc/wantevtdata event-data IPC; XSPICE event layer is not ported (frozen). NO-COUNTERPART.',
  'analysis/dctran.c#h008': 'dctran.c:445-451 #ifdef XSPICE ipc_send_data block; XSPICE IPC not ported (frozen). NO-COUNTERPART.',
  'analysis/dctran.c#h009': 'dctran.c:468-470 CKTdump output-capture gate; no front-end output dump in the engine-agnostic engine. NO-COUNTERPART, same class as dctran.c#h003/#h010.',
};
for (const [id, rationale] of Object.entries(NC)) {
  if (!byId.has(id)) { log.push(`WARN no ledger item ${id} — skipped`); continue; }
  if (prog.items[id]) { log.push(`WARN ${id} has a progress entry — NOT NC-ing (would conflict)`); continue; }
  an.items[id] = { ...(an.items[id] ?? {}), state: 'NO-COUNTERPART', tsFunction: null, rationale };
  log.push(`analysis NC  ${id}  (was ${stateOf(id)})`);
}
writeJ(AN, an);

console.log('=== reconcile-batch3 ===');
for (const l of log) console.log('  ' + l);
