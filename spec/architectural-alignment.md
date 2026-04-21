# Architectural Alignment — digiTS vs ngspice

**Date:** 2026-04-21
**Author:** Claude (Opus 4.7) with user
**Status:** All items APPROVED as of 2026-04-21 (see §0.5 approval log).
Doc is now the single source of truth for digiTS vs ngspice architectural
alignment. Moves from design to execution: each APPROVED FIX item
becomes an execution track; each APPROVED ACCEPT item becomes a harness
constraint.
**Supersedes:** `ngspice-alignment-divergences.md` + `ngspice-alignment-
verification.md` once every item here reaches an APPROVED state.
**Feeder docs:** `audit-papered-divergences.md` (source of the ~38 items
below), `baseline-reality.md` (post-papering-removal state),
`parity-forcing-function-plan.md` (why this doc exists).

---

## 0. Purpose and rules

This is the single source of truth for every **structural** way in which
digiTS's analog solver / device models / engine control flow differ in
shape from ngspice. Items here are NOT numerical bugs — those live in
`fix-list-phase-2-audit.md`. Items here are architectural: things where
fixing "the value" or "the formula" is impossible because the two engines
do not expose the same quantities in the same shapes.

### Rules for this document

1. **Every item has exactly one of two verdicts:** FIX (restructure to
   match ngspice) or ACCEPT (keep the divergence, with the specific
   numerical cost documented).
2. **No middle verdicts.** No "intentional divergence", no "equivalent
   under mapping", no "PARTIAL", no "citation only", no "pre-existing".
3. **Agents do not add items to this doc.** If an agent encounters a
   structural mismatch not listed here, the agent **escalates** — stops
   work, reports, waits. Adding items is a user action.
4. **FIX items block downstream numerical work.** Until an A-category
   item is fixed, no fix-list item that touches the same region can be
   declared bit-exact with ngspice — it is building on sand.
5. **ACCEPT items name the numerical cost.** "Accept" is not "ignore".
   An accepted divergence must specify: which slots are non-comparable,
   which tests cannot be bit-exact, which ngspice behaviors cannot be
   reproduced.

### Item lifecycle

```
PROPOSED → (user review) → APPROVED FIX  → (implementation) → LANDED
                        ↘  APPROVED ACCEPT → (cost documented) → RECORDED
```

### Source IDs

- **C-AUD-n** / **S-AUD-n** / **M-AUD-n** — items from
  `audit-papered-divergences.md`.
- **DIV-n** — items from `ngspice-alignment-divergences.md` (1–17).
- **C-n** — items from `fix-list-phase-2-audit.md` that turn out to be
  architectural rather than numerical.

---

## 0.5. Approval log

- **2026-04-21** — A1 APPROVED FIX (collapse `_updateOp`/`_stampCompanion`
  split; umbrella fix for all C-AUD state-slot inventions).
- **2026-04-21** — E1 APPROVED ACCEPT (model registry stays, per-level
  ngspice references documented; `defaultModel` may not be read at
  runtime for dispatch).
- **2026-04-21** — F4 APPROVED wholesale per subgroup (F4a 11 devices
  FIX, F4b 4 composite devices FIX, F4c 15 digiTS-only devices ACCEPT).
- **2026-04-21** — Batch approvals in ID order: **A2–A4** (state pool
  cleanup, all FIX), **B1–B5** (solver architecture, all FIX),
  **C1–C3** (engine control flow, all FIX), **D1–D4** (init-mode
  dispatch, all FIX), **E2–E4** (framework-level accepts, all ACCEPT),
  **F1** (tunnel-diode ACCEPT), **F2** (varactor FIX), **F3** (triode
  ACCEPT), **G1** (MOSFET sign convention FIX), **H1–H2** (limiting /
  gmin ownership FIX), **I2–I3** (policy items acknowledged).
- **2026-04-21** — I1 APPROVED STRICTER POLICY — no suppression of
  anomalies; diffs present loudly, only. Stricter than the originally
  proposed "cite the structural item" rule. Reconciliation pass will
  enumerate existing suppression patterns for removal.

Every item in `architectural-alignment.md` is now APPROVED. The doc
moves from design to execution. Undecided items: none.

---

## 1. Summary table

| ID | Item | Verdict |
|---|---|---|
| A1 | `_updateOp` / `_stampCompanion` split via StatePool (the generator) | **APPROVED FIX** (2026-04-21) |
| A2 | `pool.uic` boolean duplicate of `cktMode & MODEUIC` | **APPROVED FIX** (2026-04-21) |
| A3 | `statePool.analysisMode` string field duplicates `CKTmode` | **APPROVED FIX** (2026-04-21) |
| A4 | `poolBackedElements` + `refreshElementRefs` defensive resync | **APPROVED FIX** (2026-04-21) |
| B1 | `_numericLUReusePivots` absolute threshold, not column-relative | **APPROVED FIX** (2026-04-21) |
| B2 | `_hasPivotOrder` conflates Factored + NeedsOrdering | **APPROVED FIX** (2026-04-21) |
| B3 | Gmin stamped outside factor, not passed to factor routine | **APPROVED FIX** (2026-04-21) |
| B4 | `invalidateTopology` trigger parity unverified | **APPROVED FIX** (2026-04-21) |
| B5 | tranInit reorder before vs after iter-0 solve | **APPROVED FIX** (2026-04-21) |
| C1 | `dcopFinalize` runs full NR pass vs single CKTload | **APPROVED FIX** (2026-04-21) |
| C2 | `_firsttime` flag vs direct MODEINITTRAN assignment | **APPROVED FIX** (2026-04-21) |
| C3 | `cktLoad(ctx, iteration)` has iteration parameter | **APPROVED FIX** (2026-04-21) |
| D1 | `"initSmsig"` mode reaches no device code | **APPROVED FIX** (2026-04-21) |
| D2 | Diode MODEINITSMSIG body empty | **APPROVED FIX** (2026-04-21) |
| D3 | BJT L1 `dt > 0` gate hides MODEINITSMSIG entirely | **APPROVED FIX** (2026-04-21) |
| D4 | `pnjlim` missing Gillespie negative-bias branch | **APPROVED FIX** (2026-04-21) |
| E1 | `modelRegistry` + `defaultModel` + `spice-l0..l3` split | **APPROVED ACCEPT** (2026-04-21) |
| E2 | `behavioral-*.ts` family has no ngspice counterpart | **APPROVED ACCEPT** (2026-04-21) |
| E3 | `bridge-adapter` + `digital-pin-model` mixed-signal layer | **APPROVED ACCEPT** (2026-04-21) |
| E4 | Engine-agnostic coordinator / editor layer | **APPROVED ACCEPT** (2026-04-21) |
| F1 | Tunnel-diode as separate device | **APPROVED ACCEPT** (2026-04-21) |
| F2 | Varactor as separate device vs ngspice diode-reuse | **APPROVED FIX** (2026-04-21) |
| F3 | Triode (vacuum tube) as a device | **APPROVED ACCEPT** (2026-04-21) |
| F4a | 11 devices with direct ngspice primitive (schottky, zener, T-line, VSWITCH, G/E/F/H sources, potentiometer, transformer, tapped-transformer) | **APPROVED FIX** (2026-04-21) |
| F4b | 4 composite devices (polarized-cap, crystal, optocoupler, LDR) | **APPROVED FIX** (2026-04-21) |
| F4c | 15 digiTS-only devices (DIAC, SCR, TRIAC, memristor, analog-fuse, spark-gap, NTC-thermistor, ADC, DAC, comparator, schmitt-trigger, OTA, 555 timer, opamp, real-opamp) | **APPROVED ACCEPT** (2026-04-21) |
| G1 | MOSFET VSB/VBD sign convention vs ngspice MOS1vbs/MOS1vbd | **APPROVED FIX** (2026-04-21) |
| H1 | `ctx.loadCtx.limitingCollector` never synced by cktLoad | **APPROVED FIX** (2026-04-21) |
| H2 | `addDiagonalGmin` / `_needsReorder` ownership | **APPROVED FIX** (2026-04-21) |
| I1 | No suppression of anomalies — diffs present loudly, only | **APPROVED STRICTER POLICY** (2026-04-21) |
| I2 | Untrusted ngspice citations in code comments | **APPROVED POLICY** (2026-04-21) |
| I3 | Alignment specs half-implemented | **APPROVED POLICY** (2026-04-21) |

**BLOCKERs routed from Step 1 (baseline-reality.md §2.1):**
- MOSFET `GEQ`-family slot mapping gap → symptom of **A1**.
- JFET `CAP_GEQ` slot mapping gap → symptom of **A1**.
- Tunnel-diode / varactor mapping existence → **F1**, **F2**.

The three BLOCKERs all reduce to A1 or F-category decisions. They do not
need independent verdicts; they resolve as A1 and F resolve.

---

## A. State architecture

The root architectural decision under which most invented-slot problems
sit. A1 is the generator; A2–A4 are independent cleanup items on the
same pool object.

### A1. `_updateOp` / `_stampCompanion` split via StatePool — **APPROVED FIX** (2026-04-21)

**Verdict:** APPROVED FIX — collapse `_updateOp` + `_stampCompanion` into
a single `load()` per device mirroring ngspice's corresponding function.
Cross-method transfer slots are deleted; their values become locals in
`load()`. Every invented slot listed below is removed from every device's
state schema. Execution is a new track; this item is the umbrella.



**Source IDs:** S-AUD-1; generates C-AUD-1, C-AUD-2, C-AUD-4, C-AUD-5,
C-AUD-6, C-AUD-7, C-AUD-8.
**Files:** `src/solver/analog/state-pool.ts` +
`src/components/**/<device>.ts::_updateOp` / `_stampCompanion` splits.
**Ngspice counterpart:** `DIOload` / `BJTload` / `MOS1load` / `JFETload`
each compute and stamp in a single function using local variables.
Values that live only across compute-→-stamp in ngspice are local
doubles (`capbe`, `geq`, `ieq`), not stored state.

**What digiTS does:** devices split compute (`_updateOp`) from stamp
(`_stampCompanion`). Values that need to cross the split are written
into `StatePool` slots in `_updateOp` and read back in `_stampCompanion`.
Every such cross-method value has no ngspice-state analog because
ngspice doesn't store it at all.

**Invented slots this generates:**
- Diode `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`
- LED same pair (copied schema)
- Varactor same pair (cross-method read)
- BJT `L1_SLOT_CAP_GEQ_BE`, `_BC_INT`, `_BC_EXT`, `_CS`,
  `_IEQ_BE`, `_IEQ_BC_INT`, `_IEQ_BC_EXT` (7 slots)
- MOSFET `SLOT_CAP_GEQ_GS`, `_GD`, `_DB`, `_SB`, `_GB`,
  `_IEQ_GS`, `_IEQ_GD`, `_IEQ_DB`, `_IEQ_SB`, `_IEQ_GB`,
  plus `SLOT_Q_GS`, `_GD`, `_GB`, `_DB`, `_SB` (11 slots)
- JFET `SLOT_CAP_GEQ_GS`, `_GD`, `_IEQ_GS`, `_IEQ_GD` (cross-method)

**Why it's architectural, not numerical:** no formula "fixes" this. The
values *cannot* be compared to ngspice CKTstate0 because ngspice does
not write them anywhere. Any harness that reports parity on these slots
is either synthesizing an "equivalent" from our state (invented
formula), tolerating the miss (tolerance), or silently skipping (null
entry). All three were papering.

**Proposed verdict:** **FIX** — collapse each device's `_updateOp` +
`_stampCompanion` into a single `load()` that mirrors the corresponding
ngspice function. Cross-method values become local variables in
`load()`. Invented slots are deleted.

**Blast radius:** every analog device file in `src/components/**`. The
`StatePool` retains the slots that are real state (junction voltages,
charges, DC currents) — those have direct ngspice offsets. It loses the
cross-method transfer slots.

**Why not ACCEPT:** accepting this means accepting that no invented slot
can ever be bit-exact with ngspice. Every other A/B/C item below is
downstream of it — accepting A1 makes the whole forcing-function
exercise a bookkeeping task around a foundational divergence.

**Relationship to "Track B":** this WAS Track B in
`parity-forcing-function-plan.md §5`. Folding it back into Track A as
item A1 because the plan as written split "architectural alignment"
from "the single biggest architectural item", which made no sense once
drafted.

### A2. `pool.uic` duplicate of `cktMode & MODEUIC`

**Source IDs:** S-AUD-2. Devices reading it:
`diode.ts:504`, `bjt.ts:820`, `bjt.ts:1520`.
**Ngspice counterpart:** single `CKTmode` bitfield, read via
`(ckt->CKTmode & MODEUIC) && (ckt->CKTmode & MODETRANOP)`.
**What digiTS does:** `pool.uic: boolean` is a separate field on the
state pool, written alongside `CKTmode` but read independently by some
devices.

**Why it's architectural:** two sources of truth for one concept. Any
code path that writes one without the other causes silent divergence.

**Proposed verdict:** **FIX** — delete `pool.uic`. Every reader switches
to `(ctx.cktMode & MODEUIC) !== 0`.

### A3. `statePool.analysisMode: "dcOp" | "tran"` string field

**Source IDs:** S-AUD-3. Written at `analog-engine.ts:1193`; read at
assorted sites.
**Ngspice counterpart:** none. ngspice represents DCop vs transient via
`CKTmode & (MODEDCOP|MODETRAN)` bitfield.
**What digiTS does:** string enumeration duplicating what the bitfield
already encodes.

**Proposed verdict:** **FIX** — delete. All readers switch to
`ctx.cktMode & (MODEDCOP|MODETRAN)`. Matches fix-list C-2.

### A4. `poolBackedElements` + `refreshElementRefs` defensive resync

**Source IDs:** S-AUD-4. Files: `ckt-context.ts:286,511`,
`analog-engine.ts:365,1212`.
**Ngspice counterpart:** none.
**What digiTS does:** maintains a second list of elements that are
"backed by the pool", plus a `refreshElementRefs()` method called
defensively in `_seedFromDcop` and elsewhere to re-synchronize references
that drift between the ckt-context element list and the pool's own
element list.

**Why it's architectural:** the resync exists because the architecture
has two parallel element lists with independent lifecycles. Fix the
lifecycle, delete the resync.

**Proposed verdict:** **FIX** — single element list owned by
`CKTCircuitContext`. Delete `poolBackedElements` and
`refreshElementRefs`. Matches fix-list C-3.

---

## B. Solver architecture

### B1. `_numericLUReusePivots` absolute threshold, not column-relative

**Source IDs:** C-AUD-11, DIV-3, DIV-4. Files:
`src/solver/analog/sparse-solver.ts:1208-1213` + constant at line 24.
**Ngspice counterpart:** `ref/ngspice/src/maths/sparse/spfactor.c:214-227`
— column-relative (`LargestInCol * RelThreshold < ELEMENT_MAG(pPivot)`)
with fallthrough to re-reorder on failure.
**What digiTS does:** absolute threshold `|diag| < 1e-13`; returns
singular on failure (no re-reorder fallthrough).
**Why it's architectural, not just a numerical constant tweak:** the two
approaches measure different things. Column-relative validates each
stored pivot against its own column's largest remaining element;
absolute validates against zero. A stored pivot that's large in absolute
terms but tiny relative to its column is silently accepted under the
current logic.

**Proposed verdict:** **FIX** — port the column-relative guard from
`spfactor.c:214-227` verbatim, including the re-reorder fallthrough.
Constant becomes `1e-3` column-relative, not `1e-13` absolute.

### B2. `_hasPivotOrder` conflates `Factored` + `NeedsOrdering`

**Source IDs:** S-AUD-9, DIV-10. File:
`src/solver/analog/sparse-solver.ts:198,701,1328`.
**Ngspice counterpart:** two flags with orthogonal lifecycles, combined
via `IS_FACTORED(m) ((m)->Factored && !(m)->NeedsOrdering)`.

**Proposed verdict:** **FIX** — replace `_hasPivotOrder` with two flags
mirroring ngspice (`_factored`, `_needsOrdering`). Audit every set/clear
site against the ngspice lifecycle.

### B3. Gmin stamped outside factor, not passed to factor routine

**Source IDs:** DIV-9. Files:
`src/solver/analog/newton-raphson.ts:296-303`,
`src/solver/analog/sparse-solver.ts:1320` (factorWithReorder accepts
gmin), `:405` (public factor does not).
**Ngspice counterpart:** `SMPreorder(..., CKTdiagGmin)` — gmin passed
into the factor/reorder routine, applied inside.

**Proposed verdict:** **FIX** — public `factor()` takes `diagGmin?`
param. `addDiagonalGmin` call site in NR removed. The factor routine
owns apply + un-apply, matching ngspice.

### B4. `invalidateTopology` trigger parity unverified

**Source IDs:** S-AUD-n/a, DIV-11, M-AUD-6. File:
`src/solver/analog/sparse-solver.ts:465-469`.
**Ngspice counterpart:** `NeedsOrdering = YES` set at
`spalloc.c:170` (initial alloc) and `spbuild.c:788` (mid-assembly
element insertion).

**Proposed verdict:** **FIX** — trace every ngspice trigger site and
ensure a parallel `invalidateTopology()` call exists in our code.
Specifically: any code path that adds an element to an already-allocated
matrix must invalidate topology.

### B5. tranInit reorder timing (before vs after iter-0 solve)

**Source IDs:** DIV-1. Files: `src/solver/analog/newton-raphson.ts:490-494`.
**Ngspice counterpart:** `niiter.c:856-859` — `NISHOULDREORDER` set at
top of NR loop before factor dispatch.
**What digiTS does:** `forceReorder()` called at end of iteration 0,
after factor+solve. First transient NR iteration reuses DC-OP pivot
order on a matrix with completely different diagonal magnitudes
(100 kV overshoot on `tmp-hang-circuits/rl-step.dts`).

**Proposed verdict:** **FIX** — move the reorder flag set to the top of
the NR loop, mirroring `niiter.c:856-859`. Gate on
`(MODEINITJCT || (MODEINITTRAN && iterno==1))`.

---

## C. Engine control flow

### C1. `dcopFinalize` runs full NR pass vs single CKTload

**Source IDs:** C-AUD-13, DIV-2, DIV-6. Files:
`src/solver/analog/dc-operating-point.ts:222-232` + call sites at
`:337,370,406`.
**Ngspice counterpart:** `dcop.c:127,153` — one `CKTload` call, no
factor, no solve, no convergence check.
**What digiTS does:** `runNR(ctx, 1, ..., exactMaxIterations=true)`
runs cktLoad + preorder + factor + solve, plus a save/restore hook
dance to suppress spurious `postIterationHook` invocations (itself a
band-aid → I1).

**Proposed verdict:** **FIX** — replace the NR call with a direct
`cktLoad(ctx)` call. Drops the hook save/restore. Also gate on
`ctx.isTransientDcop` so that only `.OP` runs the smsig pass (DIV-6).

### C2. `_firsttime` flag vs direct MODEINITTRAN assignment

**Source IDs:** C-AUD-12, DIV-5, DIV-12. Files:
`src/solver/analog/analog-engine.ts:422-429,466-469,1166-1213`.
**Ngspice counterpart:** `dctran.c:346-350` — three-line flat block
sets `CKTmode = MODETRAN | MODEINITTRAN` directly at the DC-op →
transient transition.
**What digiTS does:** `_seedFromDcop` sets `this._firsttime = true`;
the next `step()` call inspects `_firsttime` and sets
`ctx.initMode = "initTran"`. Decouples the decision from the
transition point.

**Proposed verdict:** **FIX** — set `ctx.cktMode = (cktMode & MODEUIC)
| MODETRAN | MODEINITTRAN` directly inside `_seedFromDcop`, mirroring
`dctran.c:346`. Delete `_firsttime`.

### C3. `cktLoad(ctx, iteration)` has iteration parameter

**Source IDs:** S-AUD-8, DIV-8. File: `src/solver/analog/ckt-load.ts`.
**Ngspice counterpart:** `CKTload(CKTcircuit *ckt)` — no iteration.
Iteration-sensitive behavior keys on `CKTmode` flags (MODEINITJCT,
MODEINITFLOAT, MODEINITFIX, MODEINITTRAN, MODEINITSMSIG) and on
`CKTstate0` / `CKTstate1` comparisons.
**What digiTS does:** plumbs `iteration` through `ctx.loadCtx.iteration`;
diode damping and BJT limiting paths condition on `iteration === 0`.

**Proposed verdict:** **FIX** — drop the iteration parameter. Every
downstream consumer switches to reading `cktMode & MODEINITJCT` (first
iteration of DC-OP) or equivalent. Matches fix-list work already in
progress for Phase 2 Wave 2.2 (`cktLoad` rewrite).

---

## D. Init-mode dispatch

### D1. `"initSmsig"` mode reaches no device code

**Source IDs:** M-AUD-1, DIV-7. Files: `load-context.ts:24` (type
declaration), `newton-raphson.ts:497-499` (dispatcher sets it), zero
device consumers.
**Ngspice counterpart:** 50+ call sites branch on
`(CKTmode & MODEINITSMSIG)` in device `load` functions to compute
small-signal linearization.

**Proposed verdict:** **FIX** — every device `load()` that ngspice
gates under MODEINITSMSIG gets a parallel branch. Small-signal
linearization values (`BJTgpi` at AC operating point, MOS capacitances
from Meyer linearization, etc.) compute under this mode. The AC
analysis pre-pass becomes real rather than a dead label.

### D2. Diode `MODEINITSMSIG` body empty

**Source IDs:** C-AUD-9. File: `diode.ts:650-669`.
**Ngspice counterpart:** `dioload.c:362-374` writes `capd` into state
then `continue`s, skipping matrix stamp.
**What digiTS does:** falls through and corrupts the AC matrix with
full companion stamps.

**Proposed verdict:** **FIX** — port the three-line MODEINITSMSIG
branch verbatim: `state[CAPD_SLOT] = capd; continue;`. No fall-through.

### D3. BJT L1 `dt > 0` gate hides MODEINITSMSIG entirely

**Source IDs:** C-AUD-10. File: `bjt.ts:1789`.
**What digiTS does:** during AC analysis `dt = 0`, so the enclosing
`if (dt > 0)` block is unreachable dead code.
**Ngspice counterpart:** `bjtload.c` has no `dt > 0` gate on
MODEINITSMSIG.

**Proposed verdict:** **FIX** — remove the `dt > 0` gate around the
MODEINITSMSIG branch. Matches fix-list V4 critical in
`spec/reviews/phase-2-bjt.md`.

### D4. `pnjlim` missing Gillespie negative-bias branch

**Source IDs:** C-AUD-14, M-AUD-3. File:
`src/solver/analog/newton-raphson.ts:89-205`.
**Ngspice counterpart:** `ref/ngspice/src/spicelib/devices/devsup.c:50-58`
(also in `cyclops.c` / `device.c` historical).

**Proposed verdict:** **FIX** — port the negative-bias branch verbatim.
Numerical bug currently mis-labeled as "citation divergence".

---

## E. Framework-level decisions

These are not fix-the-function items — they are whole-framework
questions. Deciding to keep them means per-NR-iteration bit-exact parity
with ngspice is structurally unreachable for the affected surface area.

### E1. `modelRegistry` + `defaultModel` + `spice-l0..l3` split — **APPROVED ACCEPT** (2026-04-21)

**Verdict:** APPROVED ACCEPT — the model registry stays. Each level
compares against its own ngspice reference file, documented per model:
- spice-l1 BJT → `ref/ngspice/src/spicelib/devices/bjt/*`
- spice-l2 BJT → `ref/ngspice/src/spicelib/devices/bjt2/*`
- spice-l1 MOSFET → `ref/ngspice/src/spicelib/devices/mos1/*`
- spice-l2 MOSFET → `ref/ngspice/src/spicelib/devices/mos2/*`
- spice-l3 MOSFET → `ref/ngspice/src/spicelib/devices/mos3/*`
- spice-l1 JFET → `ref/ngspice/src/spicelib/devices/jfet/*`
- spice-l2 JFET → `ref/ngspice/src/spicelib/devices/jfet2/*`
- diode → `ref/ngspice/src/spicelib/devices/dio/*`

**Documented numerical cost:** none for per-model bit-exact comparison
— when a component runs under model X, the harness compares against
the ngspice file for model X. The registry is an organizational shell
around the per-model loads.

**Constraint that comes with accepting:** no code path may read
`defaultModel` at runtime (compile, param merge, or model resolution).
The element's `model` property is the sole source of truth after
placement (CLAUDE.md §Component Model Architecture). Any code that
reads `defaultModel` for dispatch is a bug.

**Source IDs:** S-AUD-5. Files: `src/compile/extract-connectivity.ts:77-97`,
`src/headless/netlist-types.ts:84`, `CLAUDE.md` "Component Model
Architecture" section.
**Ngspice counterpart:** one `DEVice` struct per model instance; model
fixed at netlist parse time.
**What digiTS does:** a component carries multiple runtime-selectable
models (behavioral + spice-l1..l3 + device-specific variants).

**Note on L2/L3/MEXTRAM:** the BJT L2/L3/MEXTRAM variants have no
counterpart inside ngspice's own `bjt1`/`bjt2` files — ngspice uses
separate device structs per level. Bit-exact parity for those levels
requires citing the matching ngspice device directory per level; the
registry in digiTS remains the organizational shell.

### E2. `behavioral-*.ts` family

**Source IDs:** S-AUD-7. Files: `behavioral-{flipflop,gate,
combinational,sequential,remaining}.ts`.
**Ngspice counterpart:** none — ngspice has no behavioral-digital layer.

**Cost of ACCEPT:** bit-exact parity question is N/A for these files.
They form a separate domain (digital behavioral) that the ngspice
comparison harness must not touch.

**Proposed verdict:** **ACCEPT.** Harness excludes behavioral-* from
parity comparison entirely. No "equivalent to ngspice X" claims.

### E3. `bridge-adapter` + `digital-pin-model`

**Source IDs:** S-AUD-6. Files:
`src/solver/analog/bridge-adapter.ts`,
`src/solver/analog/digital-pin-model.ts`,
`src/solver/coordinator.ts:55-101`.
**Ngspice counterpart:** XSPICE codemodels (fundamentally different
architecture).

**Cost of ACCEPT:** bridge nodes between analog and digital domains are
digiTS-internal. No ngspice analog. Any bit-exact parity claim on a
circuit containing bridges is restricted to the analog sub-matrix only.

**Proposed verdict:** **ACCEPT.** Harness must assert that no bridge
adapters are present in any circuit declared "bit-exact parity" with
ngspice.

### E4. Engine-agnostic coordinator / editor layer

**Source IDs:** S-AUD-12. Files: `src/solver/coordinator.ts`,
`src/solver/coordinator-types.ts`, `TopLevelBridgeState`,
`_resolvedBridgeAdapters`.
**Ngspice counterpart:** none.

**Cost of ACCEPT:** orchestration layer wraps both analog and digital
engines plus bridges. No ngspice analog. Per-NR parity claims are made
at the analog engine level, below this layer.

**Proposed verdict:** **ACCEPT.** Sanctioned by CLAUDE.md hard rule
"Engine-Agnostic Editor". No harness coverage at this layer.

---

## F. digiTS-only devices

### F1. Tunnel-diode

**Source IDs:** C-AUD-3. Files: `src/components/semiconductors/
tunnel-diode.ts`.
**Ngspice counterpart:** none — ngspice has no dedicated tunnel-diode
model.

**Cost of ACCEPT:** tunnel-diode circuits cannot participate in the
ngspice comparison harness. Tests that exercise tunnel-diode behavior
are self-compare only.

**Proposed verdict:** **ACCEPT.** Tunnel-diode excluded from harness
comparison. The `TUNNEL_DIODE_MAPPING` was already deleted in Step 1.

### F2. Varactor as separate device

**Source IDs:** C-AUD-4. Files: `src/components/semiconductors/
varactor.ts:110,259-260,315-316`.
**Ngspice counterpart:** varactor is the diode model with a specific
parameter set; ngspice does not have a separate DEVice for it.

**Cost of FIX:** varactor becomes a diode with a preset parameter block.
All per-NR comparisons go through the diode path.
**Cost of ACCEPT:** varactor stays as a digiTS-only device; comparison
is self-compare only.

**Proposed verdict:** **FIX** — convert varactor to a diode instantiation
with a predefined parameter block. Removes the duplicate state schema
and makes per-NR comparison possible.

### F3. Triode (vacuum tube)

**Source IDs:** C-AUD-15. Files:
`src/solver/analog/__tests__/harness/device-mappings.ts:473` (already
removed in Step 1).
**Ngspice counterpart:** none.

**Proposed verdict:** **ACCEPT.** Triode excluded from harness. No
"VGS_JUNCTION ≈ ngspice something" claims.

### F4. The digiTS-only / non-core-ngspice device menagerie — **APPROVED** (2026-04-21) wholesale per subgroup

F4a APPROVED FIX, F4b APPROVED FIX, F4c APPROVED ACCEPT. Breakdown below.



**Source:** full inventory of `src/components/{semiconductors,passives,
sensors,active}/*.ts`, minus the devices already covered in F1/F2/F3
(tunnel-diode, varactor, triode) and minus the trivially-equivalent
primitives (resistor, capacitor, inductor, diode, BJT, MOSFET, JFET).

Grouped by ngspice-parity feasibility. User marks each row FIX or
ACCEPT (can batch-approve a subgroup). My recommendation is in the
right column, for user override.

#### F4a — Direct ngspice primitive exists (recommended FIX)

For each of these, ngspice has a single primitive we can compare
against bit-exact. "FIX" here means: parity harness covers the device,
any invented slots are removed, the device's load path mirrors the
ngspice source file.

| Device | File | ngspice ref | Recommend |
|---|---|---|---|
| Schottky diode | `semiconductors/schottky.ts` | `dio/*` (parameter set) | FIX |
| Zener diode | `semiconductors/zener.ts` | `dio/*` (breakdown params) | FIX |
| Transmission line (lossless) | `passives/transmission-line.ts` | `tra/*` (T element) / `ltra/*` | FIX |
| Analog switch (voltage-controlled) | `active/analog-switch.ts` | `sw/*` (VSWITCH) | FIX |
| VCCS | `active/vccs.ts` | `vccs/*` (G source) | FIX |
| VCVS | `active/vcvs.ts` | `vcvs/*` (E source) | FIX |
| CCCS | `active/cccs.ts` | `cccs/*` (F source) | FIX |
| CCVS | `active/ccvs.ts` | `ccvs/*` (H source) | FIX |
| Potentiometer | `passives/potentiometer.ts` | `res/*` (two-resistor expansion or parameterized `res`) | FIX |
| Transformer | `passives/transformer.ts` | coupled inductors `K<name> L1 L2 k` | FIX |
| Tapped transformer | `passives/tapped-transformer.ts` | coupled inductors (K with tap) | FIX |

#### F4b — Composite of ngspice primitives (recommended FIX)

ngspice models these by composition, not as a single primitive.
"FIX" here means: the digiTS component compiles to the same primitive
composition ngspice would use, and parity is checked at the composite
sub-circuit level.

| Device | File | ngspice composition | Recommend |
|---|---|---|---|
| Polarized capacitor | `passives/polarized-cap.ts` | `cap/*` + `dio/*` (reverse-bias clamp) | FIX |
| Crystal | `passives/crystal.ts` | series RLC + parallel C tank | FIX |
| Optocoupler | `active/optocoupler.ts` | LED (diode) + phototransistor (BJT) | FIX |
| LDR | `sensors/ldr.ts` | parameterized `res/*` | FIX |

#### F4c — digiTS-only, no ngspice equivalent (recommended ACCEPT)

ngspice has no core primitive and no conventional composition for
these. Some have ngspice *subcircuit models* from vendors, but those
are not part of `ref/ngspice/src/spicelib/devices/`. "ACCEPT" here
means: harness excludes the device from parity comparison; tests for
these devices are self-compare only (digiTS vs its own prior snapshot).

| Device | File | Why no ngspice equivalent | Recommend |
|---|---|---|---|
| DIAC | `semiconductors/diac.ts` | not a core ngspice device | ACCEPT |
| SCR | `semiconductors/scr.ts` | not a core ngspice device | ACCEPT |
| TRIAC | `semiconductors/triac.ts` | not a core ngspice device | ACCEPT |
| Memristor | `passives/memristor.ts` | not in ngspice at all | ACCEPT |
| Analog fuse | `passives/analog-fuse.ts` | not in ngspice | ACCEPT |
| Spark gap | `sensors/spark-gap.ts` | not in ngspice | ACCEPT |
| NTC thermistor | `sensors/ntc-thermistor.ts` | behavioral, not in core ngspice | ACCEPT |
| ADC | `active/adc.ts` | behavioral mixed-signal, not an ngspice primitive | ACCEPT |
| DAC | `active/dac.ts` | behavioral mixed-signal, not an ngspice primitive | ACCEPT |
| Comparator | `active/comparator.ts` | behavioral composite | ACCEPT |
| Schmitt trigger | `active/schmitt-trigger.ts` | behavioral composite | ACCEPT |
| OTA | `active/ota.ts` | typically subcircuit, no primitive | ACCEPT |
| 555 timer | `active/timer-555.ts` | subcircuit library, no primitive | ACCEPT |
| Opamp (ideal) | `active/opamp.ts` | behavioral; ngspice uses VCVS macromodel | ACCEPT |
| Real opamp | `active/real-opamp.ts` | behavioral; ngspice uses subcircuit macromodel | ACCEPT |

#### F4 constraint (ACCEPT items)

For every ACCEPT item:
1. The harness must assert the device is absent from any circuit
   declared "bit-exact parity with ngspice".
2. The device's state pool schema is free to contain invented slots
   (since the comparison is self-compare) — but those slots do not leak
   into the main comparison harness through any mapping/tolerance
   mechanism.
3. Tests for these devices cite "self-compare snapshot" explicitly. No
   "equivalent to ngspice X" claims in comments or docs.

#### F4 constraint (FIX items)

For every FIX item in F4a/F4b:
1. A1 (state-pool collapse) lands first — no new device-level slot
   collapse work happens before A1's umbrella decision is executed.
2. The cited ngspice reference file is the single source of truth for
   load ordering, state layout, and sign conventions.
3. Parity harness gets a dedicated test file per device comparing at
   matrix-entry and state-slot granularity.

**User action:** approve the recommendation column wholesale, or mark
individual rows differently. Any batch is fine — typical shape is
"approve all F4a as FIX, all F4b as FIX, all F4c as ACCEPT".

---

## G. Sign conventions

### G1. MOSFET VSB / VBD sign convention

**Source IDs:** S-AUD-11, M-AUD-5. Files:
`src/solver/analog/__tests__/harness/device-mappings.ts:317-331,388-399`
(the `derivedNgspiceSlots` sign-flip was deleted in Step 1 —
`MOSFET_MAPPING` now does not have VSB/VBD mapped at all).
**Ngspice counterpart:** `MOS1vbs` (bulk-source, not source-bulk) and
`MOS1vbd` (bulk-drain, not drain-bulk). Opposite sign.
**What digiTS does:** computes VSB = vs − vb (source-bulk); ngspice
computes vbs = vb − vs (bulk-source). Magnitude agrees, sign flips.
The derived-slot sign-flip in device-mappings papered over this.

**Cost of FIX:** rename every MOS VSB/VBD reference in fet-base and mos1
to VBS/VBD; update every sign-sensitive consumer (derivatives, limiting,
cap-companion stamping).
**Cost of ACCEPT:** sign-sensitive parity broken forever — limiting
direction, derivative signs, cap companion sign all need bespoke
handling per comparison site.

**Proposed verdict:** **FIX** — align to ngspice sign convention. One
pass across fet-base.ts + mosfet.ts + all MOS tests.

---

## H. Limiting & Gmin infrastructure

### H1. `ctx.loadCtx.limitingCollector` never synced by cktLoad

**Source IDs:** DIV-16, DIV-17. Files:
`src/solver/analog/newton-raphson.ts` (limiting implementations),
`src/solver/analog/__tests__/harness/stream-verification.test.ts:215-231,
310-331` (failing tests).
**What digiTS does:** devices call `pnjlim`/`fetlim`/`limvds` and push
events into a local limiting collector, but cktLoad never copies those
events into `ctx.loadCtx.limitingCollector`. Harness assertions that
look at the collector see zero events.
**Ngspice counterpart:** each limiting call updates `CKTnoncon` directly
(no separate collector — limiting is a property of the NR state, not a
side-channel event stream).

**Proposed verdict:** **FIX** — two layers. First, wire cktLoad to sync
the per-device limiting events into the shared collector (trivial).
Second, audit whether `pnjlim`/`fetlim`/`limvds` implementations match
ngspice in *what they emit as events* (probably needs D4 landed first).

### H2. `addDiagonalGmin` / `_needsReorder` ownership

**Source IDs:** M-AUD-2.
**What digiTS does:** NR loop calls `solver.addDiagonalGmin(...)` and
manages `_needsReorder` semantics. Ngspice's solver routine owns both.

**Proposed verdict:** **FIX** — ownership moves into the solver. NR no
longer calls addDiagonalGmin. Falls out naturally from B3.

---

## I. Policy items (not FIX-or-ACCEPT)

These are meta-items about how the project maintains alignment going
forward. They don't have a structural code item to fix; they are
process guards.

### I1. No suppression of anomalies — diffs present loudly, only — **APPROVED STRICTER POLICY** (2026-04-21)

**Source IDs:** DIV-13 (band-aid commits). Canonical existing instance:
commit `d4dc1e3c` save/restore `postIterationHook` dance around
dcopFinalize's NR pass (C1 removes this dance entirely).

**Policy (stricter than originally proposed):**

Any divergence, anomaly, or unexpected state surfaces in output. No
code may:

- Suppress, swallow, or mute spurious events of any kind.
- Save a value, mutate, and restore it to hide a transient write.
- Catch an exception without re-raising or escalating it to a visible
  log level.
- Gate error/warning emission on a "this is expected under X" condition.
- Filter log output based on "noise vs signal" heuristics.
- Add a conditional that exists solely to silence an assertion, warning,
  or test that would otherwise fire.
- Wrap a call in a try/catch whose catch block does anything other
  than (a) attach context and rethrow, or (b) record the failure at a
  visible level.

**Rationale:** suppression patterns exist *only* because a structural
divergence produces behavior that should not exist. Silencing the
evidence instead of fixing the generator is exactly the papering
pattern the forcing function was designed to eliminate. If an anomaly
is truly benign, it stops firing when the generator is fixed; a
suppression is always a band-aid over a structural bug.

**Enforcement:** every future commit whose diff introduces one of the
above patterns is rejected at review. If a divergence is known and
explicitly ACCEPTED elsewhere in this doc, the divergence surfaces
loudly and the test that would otherwise fail is marked
excluded-by-design citing the specific ACCEPTED item. Exclusions are
explicit and named, not silent.

**Backlog:** existing suppression patterns in the codebase must be
enumerated and removed. Search surface: save/restore pairs, try/catch
without re-raise, `if (spurious || expected)` gates, suppressed
logging, test skip annotations without an APPROVED ACCEPT reference.
First removal is the `dcopFinalize` hook save/restore dance — falls
out of C1 naturally. A reconciliation pass against the codebase (post
this doc's approvals landing) enumerates the rest.

### I2. ngspice citations in code comments are untrusted

**Source IDs:** DIV-14. Named instance: commit `b4add694` introducing
`dcopFinalize`; `dc-operating-point.ts:209` cites `cktop.c`, the actual
source is `dcop.c:127,153`.

**Policy:** every `// ngspice:` / `// Matches ngspice X` citation in
the codebase is considered untrusted until verified. Future audits may
not use comment citations as authoritative — they must re-verify
against the cited ngspice file. Wave 2.4 ("F6 citation audit") did a
first pass; ongoing.

### I3. Alignment specs half-implemented

**Source IDs:** DIV-15. Named instance: `spec/phase-4-dcop-alignment.md`
— `pool.initMode = "transient"` write removed, but `dcopFinalize` NR
pass (the other half of the spec) never delivered.

**Policy:** no spec document is considered "delivered" until every
numbered item in its acceptance criteria has a LANDED commit. Partial
landings get a WIP marker; never "complete". Phase 2's current
`spec/progress.md` inherits this pattern and is a candidate for audit.

---

## 2. Crosswalk to existing docs (to be deleted once APPROVED)

This section exists to guarantee no item from the old docs is dropped.
Once every item below has an APPROVED verdict in one of the sections
above, the corresponding old doc can be deleted.

### `ngspice-alignment-divergences.md` — 17 items

| # | Title | Covered by |
|---|---|---|
| 1 | tranInit reorder timing | B5 |
| 2 | dcopFinalize runs full NR pass | C1 |
| 3 | _numericLUReusePivots has no partial-pivoting guard | B1 |
| 4 | Pivot threshold constant magnitude mismatch | B1 |
| 5 | Transient-DCOP path skips MODEINITTRAN regime | C2 |
| 6 | dcopFinalize called on transient-DCOP success path | C1 |
| 7 | "initSmsig" mode gates no device code | D1 |
| 8 | cktLoad takes an iteration argument | C3 |
| 9 | Preorder sees pre-stamped Gmin | B3 |
| 10 | _hasPivotOrder semantic mismatch | B2 |
| 11 | invalidateTopology trigger parity unverified | B4 |
| 12 | _seedFromDcop structural parallel deferred | C2 |
| 13 | Band-aid commits mask structural divergences | I1 |
| 14 | ngspice citations in code comments untrusted | I2 |
| 15 | Alignment specs partially implemented | I3 |
| 16 | Voltage limiting events not firing (test #10) | H1 |
| 17 | Voltage limiting comparison fails (test #14) | H1 |

### `audit-papered-divergences.md` — C-AUD / S-AUD / M-AUD

| ID | Title | Covered by |
|---|---|---|
| C-AUD-1 | Diode SLOT_CAP_GEQ / _IEQ invented | A1 |
| C-AUD-2 | LED duplicates same cap slots | A1 |
| C-AUD-3 | Tunnel-diode invented schema | F1 |
| C-AUD-4 | Varactor SLOT_CAP_GEQ/_IEQ cross-method | A1 + F2 |
| C-AUD-5 | BJT L1 7 invented cap slots | A1 |
| C-AUD-6 | MOSFET 11 invented cap+Q slots | A1 |
| C-AUD-7 | BJT L1 CTOT written into CAP_GEQ slots | A1 |
| C-AUD-8 | MOSFET cap companion regression | A1 (symptom); root fix via A1 collapse |
| C-AUD-9 | Diode MODEINITSMSIG body empty | D2 |
| C-AUD-10 | BJT L1 dt>0 gate hides MODEINITSMSIG | D3 |
| C-AUD-11 | _numericLUReusePivots threshold | B1 |
| C-AUD-12 | Transient-DCOP _firsttime flag | C2 |
| C-AUD-13 | dcopFinalize runs full NR pass | C1 |
| C-AUD-14 | pnjlim Gillespie branch missing | D4 |
| C-AUD-15 | Triode VGS_JUNCTION is internal limiting state | F3 |
| S-AUD-1 | StatePool cross-method buffer | A1 |
| S-AUD-2 | pool.uic boolean mirror | A2 |
| S-AUD-3 | statePool.analysisMode string | A3 |
| S-AUD-4 | poolBackedElements + refreshElementRefs | A4 |
| S-AUD-5 | modelRegistry / defaultModel / spice-l0..l3 | E1 |
| S-AUD-6 | bridge-adapter + digital-pin-model | E3 |
| S-AUD-7 | behavioral-*.ts family | E2 |
| S-AUD-8 | cktLoad(iteration) signature | C3 |
| S-AUD-9 | _hasPivotOrder conflation | B2 |
| S-AUD-10 | preFactorMatrix diagnostic (policy-OK) | — (no action, policy-OK per plan.md GP6) |
| S-AUD-11 | MOSFET VSB/VBD sign inversion | G1 |
| S-AUD-12 | Engine-agnostic coordinator layer | E4 |
| M-AUD-1 | initSmsig mode mis-labeled numerical | D1 |
| M-AUD-2 | NR ownership of addDiagonalGmin | H2 |
| M-AUD-3 | pnjlim item F6-L2 mis-labeled citation | D4 |
| M-AUD-4 | "Extra diagnostics permitted" escape-hatch | I1 (policy) |
| M-AUD-5 | Sign-inverted MOSFET voltages | G1 |
| M-AUD-6 | invalidateTopology trigger parity | B4 |

Every item from both source docs is covered. Nothing dropped.

---

## 3. Proposed decision order (once the user reviews this doc)

Suggested review order — user can reject any of these:

1. **A1 first, alone.** It's the generator of the invented-slot problem
   and half the C-AUD items resolve as symptoms of its resolution. No
   A2–H2 item should be approved until A1 has a verdict, because many
   of the others' costs change depending on A1's resolution.
2. **E1 next.** Framework decision; affects how every model's parity is
   measured.
3. **F4 next.** Per-device decisions for the digiTS-only menagerie.
4. **Everything else in ID order.** B1–H2 are largely independent and
   can be approved in any order.
5. **I1–I3 are policy.** Record and move on.

## 4. Next step after approvals

Once each item has an APPROVED verdict:

- **Reconciliation.** Walk `fix-list-phase-2-audit.md` and
  `audit-papered-divergences.md`. Each fix-list item gets re-classified:
  PARITY (genuine numerical, stays), BLOCKER (routes to Track A item
  here), or OBSOLETE (was itself papering, delete).
- **Deletion of `ngspice-alignment-divergences.md` +
  `ngspice-alignment-verification.md`.** Replaced by this doc.
- **§3.3 vocabulary ban** lands in CLAUDE.md — the words *mapping*,
  *tolerance*, *close enough*, *equivalent to*, *pre-existing* banned
  as closing verdicts on ngspice-comparison work, with escalation to
  this doc as the mandated alternative.
