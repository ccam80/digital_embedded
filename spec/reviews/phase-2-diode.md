# Review Report: Phase 2 — Diode MODEINITSMSIG + bitfield migration (Tasks 2.4.1, 2.4.9a)

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 (2.4.1, 2.4.9a) |
| Violations — critical | 3 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 2 |
| Weak tests | 4 |
| Legacy references | 1 |

**Verdict: has-violations**

---

## Violations

### V-1 — CRITICAL — exp(700) clamp reintroduced in `computeDiodeIV`

**File**: `src/components/semiconductors/diode.ts`  
**Line**: 344  
**Rule**: Phase 0 rule "Delete BJT exp(700) clamps" + CLAUDE.md "No exp(700) clamps reintroduced in diode.ts" (review assignment emphasis item 7) + rules.md "No fallbacks. No safety wrappers."

**Evidence**:
```ts
const expArg = Math.min(vd / nVt, 700);
const evd = Math.exp(expArg);
```

The review assignment explicitly states "No exp(700) clamps reintroduced in diode.ts." Phase 0 deleted these clamps from BJT as "banned" (CLAUDE.md SPICE-correct only rule). The same ban applies to the diode. ngspice `dioload.c` line 244 does `evd = exp(vd/vte)` with no clamp. The 700-clamp is a numerical safety wrapper not present in the ngspice reference. The function `computeDiodeIV` is called directly from `load()` at line 557 and thus affects every NR iteration.

---

### V-2 — CRITICAL — MODEINITSMSIG store-back body is empty; `continue` semantics not implemented; matrix is stamped during small-signal phase

**File**: `src/components/semiconductors/diode.ts`  
**Lines**: 650–669  
**Rule**: CLAUDE.md "SPICE-Correct Implementations Only"; rules.md "Never mark work as deferred, TODO, or 'not implemented'"

**Evidence**:
```ts
// Small-signal parameter store-back (dioload.c:360-372). Only during
// MODEINITSMSIG, and only when NOT (MODETRANOP && MODEUIC).
if ((mode & MODEINITSMSIG) &&
    !((mode & MODETRANOP) && (mode & MODEUIC))) {
  // dioload.c:363 stores capd ( = capGeq-equivalent total cap ) into
  // DIOcapCurrent slot. Our SLOT_CAP_GEQ already carries Ctotal*ag[0];
  // the ngspice slot is the raw cap (capd). We store Ctotal into V
  // or a dedicated slot. Since our schema does not yet split
  // capd vs capGeq, we use SLOT_CAP_GEQ as the closest analog and
  // flag this as a LATENT divergence below (see Additional Divergences).
}

if (capGeq !== 0 || capIeq !== 0) {
  stampG(solver, nodeJunction, nodeJunction, capGeq);
  ...
}
```

ngspice `dioload.c:360-374` (ground truth):
```c
if( (!(ckt->CKTmode & MODETRANOP)) || (!(ckt->CKTmode & MODEUIC)) ) {
    if (ckt->CKTmode & MODEINITSMSIG){
        *(ckt->CKTstate0 + here->DIOcapCurrent) = capd;
        ...
        continue;   // <-- skips matrix stamp AND remainder of device loop body
    }
    // NIintegrate path (transient)
    ...
}
```

There are two separate violations here:

**2a — Empty body / deferred implementation**: The `if (MODEINITSMSIG)` body stores nothing. ngspice stores `capd` (raw capacitance) into `DIOcapCurrent` slot (state0). The code acknowledges this as "LATENT divergence" and stores nothing. A comment describing why the spec was not met is not a valid substitute for the implementation.

**2b — Missing `continue` (early return) semantics**: After storing `capd`, ngspice executes `continue`, which skips the `NIintegrate` call AND the subsequent matrix stamp (`stampG`/`stampRHS`) for the cap block. The TS code falls through to stamp the matrix during `MODEINITSMSIG`. This is incorrect behavior: during AC small-signal linearization, the companion model stamp should NOT be written — only `capd` goes to state0 for use by the AC solver. The matrix is being incorrectly written during the SMSIG phase.

The comment "flag this as a LATENT divergence" is a historical-provenance comment decorating dead/incomplete code and is itself a rule violation per rules.md §Code Hygiene.

---

### V-3 — CRITICAL — Historical-provenance comment decorates empty/incomplete code block

**File**: `src/components/semiconductors/diode.ts`  
**Lines**: 650–660  
**Rule**: rules.md "Historical-provenance comments are dead-code markers. Any comment containing words like 'legacy', 'fallback', 'for now' ... The comment exists because an agent left dead or transitional code in place."

**Evidence**:
```ts
// flag this as a LATENT divergence below (see Additional Divergences).
```

Also:
```ts
// dioload.c:363 stores capd ( = capGeq-equivalent total cap ) into
// DIOcapCurrent slot. Our SLOT_CAP_GEQ already carries Ctotal*ag[0];
// the ngspice slot is the raw cap (capd). We store Ctotal into V
// or a dedicated slot. Since our schema does not yet split
// capd vs capGeq, we use SLOT_CAP_GEQ as the closest analog and
// flag this as a LATENT divergence below (see Additional Divergences).
```

The phrase "LATENT divergence" and "does not yet split" are historical-provenance language describing what the code does NOT do and why. Per rules.md this is proof the agent knowingly left the implementation incomplete. The comment decorates an empty body (V-2 above). Both the comment and the empty body must be treated as a single critical dead-code finding.

---

### V-4 — MAJOR — MODEINITJCT UIC path uses `pool.uic` instead of bitfield `(mode & MODETRANOP) && (mode & MODEUIC)`

**File**: `src/components/semiconductors/diode.ts`  
**Lines**: 500–506  
**Rule**: CLAUDE.md "SPICE-Correct Implementations Only"; review assignment emphasis item 1 (initPred/vdRaw selection must match dioload.c exactly)

**Evidence**:
```ts
} else if (mode & MODEINITJCT) {
  // dioload.c:130-135: MODEINITJCT with OFF / UIC / fallback.
  if (params.OFF) {
    vdRaw = 0;
  } else if (pool.uic && !isNaN(params.IC)) {
    vdRaw = params.IC;
  } else {
    vdRaw = tVcrit;
  }
}
```

ngspice `dioload.c:129-132`:
```c
} else if ( (ckt->CKTmode & MODEINITJCT) &&
        (ckt->CKTmode & MODETRANOP) && (ckt->CKTmode & MODEUIC) ) {
    vd=here->DIOinitCond;
} else if ( (ckt->CKTmode & MODEINITJCT) && here->DIOoff) {
    vd=0;
} else if ( ckt->CKTmode & MODEINITJCT) {
    vd=here->DIOtVcrit;
```

The ngspice IC path requires both `MODETRANOP` and `MODEUIC` bits to be set in `CKTmode` — it is not a general `pool.uic` flag. The implementation reads `pool.uic` (a StatePool field that is a boolean mirror), not `(mode & MODETRANOP) && (mode & MODEUIC)`. Additionally, the ordering is wrong: in ngspice, the UIC path is tested BEFORE the OFF path. The implementation tests OFF first. This is not bit-exact with dioload.c.

Furthermore, review assignment emphasis item 1 states: "Check that `vdRaw` picks from the correct state slot for each of MODEINITFLOAT / MODEINITJCT / MODEINITFIX / MODEINITSMSIG / MODEINITTRAN / MODEINITPRED." The MODEINITFIX path is missing from the `vdRaw` selection entirely — dioload.c line 136 handles `MODEINITFIX && here->DIOoff` by setting `vd=0`, which is distinct from the MODEINITJCT+OFF path. This is covered in V-5.

---

### V-5 — MAJOR — MODEINITFIX+OFF path missing from `vdRaw` selection

**File**: `src/components/semiconductors/diode.ts`  
**Lines**: 492–514 (the `vdRaw` selection block)  
**Rule**: CLAUDE.md "SPICE-Correct Implementations Only"; review assignment emphasis item 1

**Evidence** — current vdRaw selection:
```ts
if (mode & MODEINITSMSIG) {
  vdRaw = s0[base + SLOT_VD];
} else if (mode & MODEINITTRAN) {
  vdRaw = s1[base + SLOT_VD];
} else if (mode & MODEINITJCT) {
  if (params.OFF) { vdRaw = 0; }
  else if (pool.uic && !isNaN(params.IC)) { vdRaw = params.IC; }
  else { vdRaw = tVcrit; }
} else {
  // Normal linearization from the NR iterate.
  ...
}
```

ngspice `dioload.c:136`:
```c
} else if ( ckt->CKTmode & MODEINITFIX && here->DIOoff) {
    vd=0;
```

The `MODEINITFIX && here->DIOoff` case is handled in ngspice as a separate condition that sets `vd=0`. In the TS implementation, when `mode & MODEINITFIX` is set (and OFF=1), execution falls through to the `else` branch (normal NR iterate), which reads `voltages[nodeJunction-1] - voltages[nodeCathode-1]`. This is incorrect; the diode should have its voltage forced to 0 during MODEINITFIX when OFF=1.

---

### V-6 — MINOR — Comment in `load()` misidentifies the MODEINITPRED branch purpose

**File**: `src/components/semiconductors/diode.ts`  
**Lines**: 479–490  
**Rule**: rules.md "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed..."

**Evidence**:
```ts
// MODEINITPRED — #ifndef PREDICTOR path. dioload.c:98-99 (#ifndef
// PREDICTOR block): adopt predictor-extrapolated vd, but since ngspice
// ships with PREDICTOR #undef by default, this branch is NEVER entered
// in reference builds (nipred.c:20 early-returns, cktdefs.h builds
// never set MODEINITPRED). We retain an inert branch so state rotation
// still works if a future engine re-enables the predictor, matching
// dioload.c:128.
```

The comment says "We retain an inert branch so state rotation still works if a future engine re-enables the predictor." This is a forward-compatibility justification for a branch that the comment itself says is "NEVER entered." Per rules.md §Code Hygiene: "No feature flags, no environment-variable toggles for old/new behaviour." A dead branch retained for a hypothetical future feature is a form of deferred implementation (banned). Additionally the phrase "We retain" is historical-provenance language.

However, the code itself (state rotation on MODEINITPRED) accurately mirrors dioload.c:141-147, so the branch is correct; only the comment is problematic. Reported as minor.

---

## Gaps

### G-1 — MODEINITSMSIG store-back does not write `capd` to `DIOcapCurrent` slot

**Spec requirement** (F4 Deliverable 5.1, citing dioload.c:362-363):
```
dioload.c:362-363: if (ckt->CKTmode & MODEINITSMSIG){
    *(ckt->CKTstate0 + here->DIOcapCurrent) = capd;
```
The spec spec body in the NEW block explicitly includes this store-back. The progress.md entry for task 2.4.1 states "empty body per spec — latent divergence noted." However the F4 spec's NEW code block shows the actual store-back is required (`DIOcapCurrent = capd`). The agent's characterization of the empty body as "per spec" is incorrect — the spec requires the write.

**What was found**: Empty `if` body with comment acknowledging the omission. No state write to any slot equivalent to `DIOcapCurrent`. The nearest equivalent slot (`SLOT_CAP_GEQ`) is not written during SMSIG (it is written unconditionally before the SMSIG gate is reached, but as `capGeq = niIntegrate(...)` — not as raw `capd`).

**File**: `src/components/semiconductors/diode.ts`, lines 652–660

---

### G-2 — MODEINITSMSIG branch does not execute `continue` (early return from cap block)

**Spec requirement** (dioload.c:374): After writing `capd` to state0, ngspice executes `continue` (continuing the outer instance loop), which skips both NIintegrate and the subsequent matrix stamp for the cap companion. The TS code falls through to stamp the matrix.

**What was found**: After the empty SMSIG body, execution continues to `if (capGeq !== 0 || capIeq !== 0) { stampG(...) }` at lines 662–669. During MODEINITSMSIG the cap companion should NOT be stamped into the matrix — the AC solver uses the stored `capd` directly. The matrix is being corrupted with transient companion values during the AC linearization phase.

**File**: `src/components/semiconductors/diode.ts`, lines 662–669

---

## Weak Tests

### W-1 — `cap gate fires under MODEAC` only checks `> 0`, not exact value

**Test**: `src/components/semiconductors/__tests__/diode.test.ts::diode MODEINITSMSIG seeding::cap gate fires under MODEAC (dioload.c:316-317)`  
**Lines**: 1280–1320

**Evidence**:
```ts
expect(pool.state0[4]).toBeGreaterThan(0);
```

`pool.state0[4]` is `SLOT_CAP_GEQ`. The assertion only checks positivity. It does not verify the exact value against the ngspice formula `capGeq = ag[0] * Ctotal` where `Ctotal = computeJunctionCapacitance(vd, ...) + TT * gd`. A trivially small but positive value would pass this test even if the formula were wrong. The spec requires bit-exact compliance.

---

### W-2 — `cap gate fires under MODETRANOP | MODEUIC` only checks `> 0`, not exact value

**Test**: `src/components/semiconductors/__tests__/diode.test.ts::diode MODEINITSMSIG seeding::cap gate fires under MODETRANOP | MODEUIC (dioload.c:316-317)`  
**Lines**: 1322–1360

**Evidence**:
```ts
expect(pool.state0[4]).toBeGreaterThan(0);
```

Same issue as W-1. The cap gate is tested only for positivity, not for the correct computed capacitance value.

---

### W-3 — `MODEINITSMSIG seeds vdRaw from state0` does not verify pnjlim was skipped AND no matrix side-effect from incorrect continue behavior

**Test**: `src/components/semiconductors/__tests__/diode.test.ts::diode MODEINITSMSIG seeding::MODEINITSMSIG seeds vdRaw from state0 (not NR iterate)`  
**Lines**: 1159–1199

**Evidence**:
```ts
// SLOT_VD must remain 0.4V (seeded from state0, not the 2V iterate).
expect(pool.state0[0]).toBeCloseTo(0.4, 6);
```

The test only verifies that SLOT_VD equals the state0 seed. It does not verify that:
- No matrix stamp for the cap companion was written (which would reveal the missing `continue` behavior in G-2)
- The noncon counter remains 0 (redundant with W-4 which is a separate test — but SMSIG seed test should verify both)

---

### W-4 — `MODEINITSMSIG skips pnjlim` test does not verify SLOT_CAP_GEQ was NOT written when there is no capacitance

**Test**: `src/components/semiconductors/__tests__/diode.test.ts::diode MODEINITSMSIG seeding::MODEINITSMSIG skips pnjlim (no noncon increment)`  
**Lines**: 1241–1278

**Evidence**:
```ts
expect(noncon.value).toBe(0);
```

The test uses `CJO: 0` (resistive diode, no capacitance). It verifies `noncon=0` but does not test the behavior of a capacitive diode under MODEINITSMSIG, where the critical issue (V-2/G-2) manifests. A test that specifically exercises the capacitive diode with MODEINITSMSIG and verifies the matrix is NOT stamped is missing.

---

## Legacy References

### L-1 — `pool.uic` used instead of `(mode & MODETRANOP) && (mode & MODEUIC)` (legacy boolean mirror)

**File**: `src/components/semiconductors/diode.ts`  
**Line**: 504

**Evidence**:
```ts
} else if (pool.uic && !isNaN(params.IC)) {
```

`pool.uic` is a legacy boolean mirror field on StatePool (retained per the F4 spec's own note: "uic: boolean retained because many call sites already read it; engines MUST keep both in sync. Remove once every reader is migrated to cktMode"). The diode `load()` is reading this legacy field rather than `(mode & MODETRANOP) && (mode & MODEUIC)` from the bitfield. The review assignment explicitly lists this as a check (item 1): "vdRaw picks from the correct state slot". The F4 spec's LoadContext NEW block marks `uic: boolean` as a retained field pending migration, but ngspice's equivalent condition (`MODEINITJCT && MODETRANOP && MODEUIC`) is entirely in the bitfield. The device load must test the bitfield, not the pool's legacy mirror.
