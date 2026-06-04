#!/usr/bin/env node
/* loop-preflight-audit.mjs — one-shot read-only audit of ledger.json + progress.json.
 * Replicates the port-loop SCOUT deferral rules mechanically so we know, BEFORE a
 * run: how many hunks get attempted, how many cheap-checked (STALE), how many are
 * blocked by gaps (unmapped / spec-less recon / deferred unit), and where every gap is.
 * Edits nothing. */
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ledger = JSON.parse(readFileSync(join(HERE, 'ledger.json'), 'utf8'));
const items = ledger.items;
const byId = new Map(items.map((i) => [i.id, i]));
const unitOf = (it) => basename(it.diffDoc ?? 'NULLDOC', '.md');
const hasSrcMap = (it) => !!it.tsFunction && /src\/[^\s]+\.ts/.test(String(it.tsFunction));
const reconState = (id) => byId.get(id)?.state ?? null;

// Units the (corrected) scout still holds back: parser is frozen engine-phase
// (only nodeAllocOrder is live, already APPLIED); nodeset-ic/tf have no input
// surface. csw/asrc/jfet2/mes are NO LONGER deferred — they are emitted build jobs.
const MANIFEST_DEFERRED = new Set();

// ---- global state tally ----
const states = {};
for (const it of items) states[it.state] = (states[it.state] ?? 0) + 1;

// ---- per-unit aggregation ----
const units = new Map();
function U(name) {
  if (!units.has(name)) units.set(name, {
    name,
    hunkPending: 0, hunkMapped: 0, hunkUnmapped: 0,
    hunkApplied: 0, hunkStale: 0, hunkEscalated: 0, hunkNC: 0,
    hunkBlockedByRecon: 0,
    reconTotal: 0, reconPending: 0, reconStale: 0, reconApplied: 0,
    reconPendingSpecOK: 0, reconPendingSpecMissing: 0, reconStaleSpecOK: 0,
    reconIds: [],
  });
  return units.get(name);
}
for (const it of items) {
  const u = U(unitOf(it));
  if (it.kind === 'reconstruction') {
    u.reconTotal++;
    u.reconIds.push(`${it.id} [${it.state}${it.specExists ? '' : ' SPEC-MISSING'}]`);
    if (it.state === 'PENDING') { u.reconPending++; it.specExists ? u.reconPendingSpecOK++ : u.reconPendingSpecMissing++; }
    else if (it.state === 'STALE') { u.reconStale++; if (it.specExists) u.reconStaleSpecOK++; }
    else if (it.state === 'APPLIED') u.reconApplied++;
    continue;
  }
  // hunk
  switch (it.state) {
    case 'PENDING': {
      u.hunkPending++;
      if (hasSrcMap(it)) u.hunkMapped++; else u.hunkUnmapped++;
      if (it.blockedBy && reconState(it.blockedBy) !== 'APPLIED') u.hunkBlockedByRecon++;
      break;
    }
    case 'APPLIED': u.hunkApplied++; break;
    case 'STALE': u.hunkStale++; break;
    case 'ESCALATED': u.hunkEscalated++; break;
    case 'NO-COUNTERPART': u.hunkNC++; break;
  }
}

// ---- classify each unit the way the scout will ----
function classify(u) {
  const reasons = [];
  if (MANIFEST_DEFERRED.has(u.name)) reasons.push('manifest-deferred set');
  if (u.reconPendingSpecMissing > 0) reasons.push(`${u.reconPendingSpecMissing} PENDING recon(s) with NO spec file`);
  if (u.hunkUnmapped > 0) reasons.push(`${u.hunkUnmapped} unmapped PENDING hunk(s) (tsFunction null)`);
  const deferred = reasons.length > 0;
  // attemptable now (only if NOT deferred): mapped PENDING hunks not blocked by an unbuilt recon,
  // + PENDING recons with spec, + STALE recons/hunks (cheap re-verify).
  let attemptHunks = 0, attemptRecons = 0, cheapHunks = 0, cheapRecons = 0;
  if (!deferred) {
    attemptHunks = u.hunkMapped - u.hunkBlockedByRecon; // mapped, not recon-blocked
    if (attemptHunks < 0) attemptHunks = 0;
    attemptRecons = u.reconPendingSpecOK;
    cheapHunks = u.hunkStale;
    cheapRecons = u.reconStaleSpecOK;
  }
  return { deferred, reasons, attemptHunks, attemptRecons, cheapHunks, cheapRecons };
}

// ---- totals ----
let T = {
  attemptHunks: 0, attemptRecons: 0, cheapHunks: 0, cheapRecons: 0,
  deferredUnits: 0, portableUnits: 0,
  blockedUnmappedHunks: 0, specMissingRecons: 0,
  pendingHunksInDeferredUnits: 0,
};
const rows = [];
for (const u of [...units.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const c = classify(u);
  T.attemptHunks += c.attemptHunks; T.attemptRecons += c.attemptRecons;
  T.cheapHunks += c.cheapHunks; T.cheapRecons += c.cheapRecons;
  T.blockedUnmappedHunks += u.hunkUnmapped;
  T.specMissingRecons += u.reconPendingSpecMissing;
  if (c.deferred) { T.deferredUnits++; T.pendingHunksInDeferredUnits += u.hunkPending; }
  else if (c.attemptHunks + c.attemptRecons + c.cheapHunks + c.cheapRecons > 0) T.portableUnits++;
  rows.push({ u, c });
}

// ---- print ----
console.log('======== GLOBAL STATE TALLY (all items, all units) ========');
for (const [s, n] of Object.entries(states).sort()) console.log(`  ${s.padEnd(16)} ${n}`);
const totalItems = items.length;
const nc = states['NO-COUNTERPART'] ?? 0;
console.log(`  ${'TOTAL'.padEnd(16)} ${totalItems}`);
console.log(`  non-NO-COUNTERPART: ${totalItems - nc}`);
console.log('');
console.log('======== WHAT THE NEXT FULL RUN WOULD DO (scout rules applied) ========');
console.log(`  Hunks ATTEMPTED (mapped, PENDING, not recon-blocked, non-deferred unit): ${T.attemptHunks}`);
console.log(`  Recons ATTEMPTED (PENDING + spec present, non-deferred unit):            ${T.attemptRecons}`);
console.log(`  Hunks CHEAP re-verify (STALE, non-deferred unit):                        ${T.cheapHunks}`);
console.log(`  Recons CHEAP re-verify (STALE + spec present, non-deferred unit):        ${T.cheapRecons}`);
console.log(`  => TOTAL items the run touches:  ${T.attemptHunks + T.attemptRecons + T.cheapHunks + T.cheapRecons}`);
console.log('');
console.log('======== GAPS (why the rest is NOT attempted) ========');
console.log(`  Deferred units: ${T.deferredUnits}`);
console.log(`  PENDING hunks trapped in deferred units: ${T.pendingHunksInDeferredUnits}`);
console.log(`  Unmapped PENDING hunks (tsFunction null — no TS counterpart authored): ${T.blockedUnmappedHunks}`);
console.log(`  PENDING recons with NO spec file (HARD gap — unbuildable): ${T.specMissingRecons}`);
console.log('');
console.log('======== PER-UNIT BREAKDOWN ========');
console.log('unit'.padEnd(16), 'P/recon', 'attH', 'attR', 'chpH', 'chpR', 'unmap', 'specX', 'state');
for (const { u, c } of rows) {
  // skip fully-quiet units (nothing pending/stale/escalated and no recons)
  const live = u.hunkPending + u.hunkStale + u.hunkEscalated + u.reconTotal;
  if (live === 0) continue;
  const flag = c.deferred ? `DEFER(${c.reasons.join('; ')})` : 'PORTABLE';
  console.log(
    u.name.padEnd(16),
    String(u.reconPending + u.reconStale).padStart(7),
    String(c.attemptHunks).padStart(4),
    String(c.attemptRecons).padStart(4),
    String(c.cheapHunks).padStart(4),
    String(c.cheapRecons).padStart(4),
    String(u.hunkUnmapped).padStart(5),
    String(u.reconPendingSpecMissing).padStart(5),
    flag,
  );
}
console.log('');
console.log('======== ALL RECONSTRUCTION ITEMS (the under-prep risk surface) ========');
for (const { u } of rows) {
  if (!u.reconTotal) continue;
  console.log(`  [${u.name}]`);
  for (const r of u.reconIds) console.log(`     ${r}`);
}
console.log('');
console.log('======== RECONS THE RUN WILL TOUCH (attempt or cheap re-verify) — implementability surface ========');
for (const it of items) {
  if (it.kind !== 'reconstruction') continue;
  if (!(it.state === 'PENDING' || it.state === 'STALE')) continue;
  const u = unitOf(it);
  const uu = units.get(u);
  const c = uu ? classify(uu) : { deferred: true, reasons: ['?'] };
  if (c.deferred) continue; // won't be touched
  const wholeClass = /wholeClass/.test(it.id);
  console.log(`  ${it.id}`);
  console.log(`     state=${it.state}  specExists=${it.specExists}  ${wholeClass ? '*** FROM-SCRATCH CLASS BUILD ***' : ''}`);
  console.log(`     spec=${it.spec}`);
  console.log(`     tsFiles(${(it.tsFiles || []).length})=[${(it.tsFiles || []).join(', ')}]`);
  console.log(`     blocks ${(it.blocks || []).length} hunk(s)`);
}
console.log('');
console.log('======== CONDITIONAL HUNKS (mapped PENDING, blocked by THIS-RUN recon — unblock only if recon lands) ========');
let condTotal = 0;
const condByUnit = new Map();
for (const it of items) {
  if (it.kind !== 'hunk' || it.state !== 'PENDING' || !hasSrcMap(it)) continue;
  if (!it.blockedBy) continue;
  const b = byId.get(it.blockedBy);
  if (!b || b.state === 'APPLIED') continue; // already counted as attemptable
  const u = unitOf(it);
  const uu = units.get(u);
  const c = uu ? classify(uu) : null;
  if (!c || c.deferred) continue; // in a deferred unit — counted as trapped
  condTotal++;
  condByUnit.set(it.blockedBy, (condByUnit.get(it.blockedBy) ?? 0) + 1);
}
console.log(`  total: ${condTotal} hunk(s) waiting on a this-run recon`);
for (const [rid, n] of [...condByUnit.entries()].sort((a,b)=>b[1]-a[1])) console.log(`     ${n.toString().padStart(3)}  blocked by ${rid} [${reconState(rid)}]`);
console.log('');
console.log('======== DEFERRED-UNIT PENDING-HUNK COMPOSITION (the 232 trapped) ========');
for (const { u, c } of rows) {
  if (!c.deferred || u.hunkPending === 0) continue;
  console.log(`  [${u.name}] ${u.hunkPending} PENDING hunk(s) — ${c.reasons.join('; ')}`);
}
console.log('');
console.log('======== ESCALATED ITEMS ========');
for (const it of items) if (it.state === 'ESCALATED') console.log(`  ${it.id} :: ${(it.escalation && (it.escalation.note || JSON.stringify(it.escalation))) || '(no detail)'}`);
console.log('');
console.log('======== STALE ITEMS (from meta) ========');
for (const s of (ledger.meta.staleItems ?? [])) console.log(`  ${s.id} (was ${s.from})`);
