# INITF mode ladder — transient extension

## Problem

`newton-raphson.ts` walks the INITF ladder (`MODEINITJCT → MODEINITFIX → MODEINITFLOAT` for DC-OP, `MODEINITTRAN → MODEINITFLOAT` for transient init, `MODEINITPRED → MODEINITFLOAT` for transient predictor) inside a single NR call, mirroring ngspice's `niiter.c:1050-1085` INITF dispatcher. This control flow matches ngspice exactly.

The harness consumes per-iteration cktMode snapshots and synthesizes attempt boundaries from cktMode-bit changes. The ngspice bridge (`ngspice-bridge.ts:700-723`) applies this rule uniformly: any cktMode-derived `attemptPhase` change opens a new attempt.

Our engine's `dcopModeLadder` (`ckt-context.ts:412-415`, `newton-raphson.ts:609-619`) emits `onModeBegin/End` callbacks at the JCT→FIX and FIX→FLOAT transitions inside the DC-OP NR call. The harness uses these to synthesize separate attempts for each INITF mode, matching the bridge's attempt structure for DC-OP.

**The ladder is not wired for transient INITF transitions.** The dispatcher branches at `newton-raphson.ts:622, 629, 631` (`MODEINITTRAN`, `MODEINITPRED`, `MODEINITSMSIG`) flip cktMode but emit no ladder callback. Result: our engine reports one attempt for `INITTRAN+INITFLOAT` and one for `INITPRED+INITFLOAT`; the bridge reports two each. This is the divergence surfaced by `_diag-diode-resistor-tran.test.ts` — every numerical value is bit-exact, but the attempt-grouping shapes do not match.

The fix is purely instrumentation. No engine numerics change. No control flow change. Per-iteration cktMode capture is already correct on both sides.

## Scope

Extend the existing INITF mode-ladder mechanism to fire on transient INITF transitions, so attempt-grouping is symmetric across DC-OP and transient. After the change, the ngspice bridge and our engine emit identical attempt structures for every wave 10.x circuit.

Out of scope:
- Numerical engine changes
- Bridge `isPhaseChange` logic changes (the bridge's split-on-cktMode rule is correct and stays)
- DC-OP ladder semantics (already correct)

## Design

### Rename `dcopModeLadder` → `nrModeLadder`

The ladder is not DC-OP-specific — it tracks INITF transitions across DC-OP and transient. Rename for accuracy. Per the user's NO LEGACY SHIMS rule (`MEMORY.md`), no alias, no compatibility re-export. Every reference site updates in one pass.

Files touched by rename:
- `src/solver/analog/ckt-context.ts` — field declaration, reset
- `src/solver/analog/newton-raphson.ts` — read site
- `src/solver/analog/dc-operating-point.ts` — assignment sites (4 occurrences)
- `src/solver/analog/analog-engine.ts` — null assignment for production path
- `src/solver/analog/__tests__/newton-raphson.test.ts` — three test fixtures

### Widen the phase-string union

Update the ladder type in `ckt-context.ts:412-415`:

```ts
type NrModePhase =
  | "dcopInitJct"
  | "dcopInitFix"
  | "dcopInitFloat"
  | "tranInit"      // MODEINITTRAN
  | "tranPredictor" // MODEINITPRED
  | "tranNR";       // MODEINITFLOAT in a transient context

nrModeLadder: {
  onModeBegin(phase: NrModePhase, iteration: number): void;
  onModeEnd(phase: NrModePhase, iteration: number, converged: boolean): void;
} | null;
```

Phase string choice rationale: the bridge already maps `MODEINITTRAN → "tranInit"`, `MODEINITPRED → "tranPredictor"`, `MODEINITFLOAT → "tranNR"` (in a transient context) at `ngspice-bridge.ts:78-81`. Using the same names on our side means the harness can compare attempt phases by string equality without per-side normalization.

### Extend the INITF dispatcher

In `newton-raphson.ts:622-633`, add ladder callbacks symmetric to the DC-OP branches. Branches `MODEINITTRAN`, `MODEINITPRED`, and `MODEINITSMSIG` all transition to `MODEINITFLOAT`:

```ts
} else if (curInitf === MODEINITTRAN) {
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
  if (ladder) {
    ladder.onModeEnd("tranInit", iteration, false);
    ladder.onModeBegin("tranNR", iteration + 1);
  }
} else if (curInitf === MODEINITPRED) {
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
  if (ladder) {
    ladder.onModeEnd("tranPredictor", iteration, false);
    ladder.onModeBegin("tranNR", iteration + 1);
  }
} else if (curInitf === MODEINITSMSIG) {
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
  // MODEINITSMSIG is small-signal AC bias; no transient counterpart in the bridge.
  // No ladder callback — the AC harness does not consume this transition.
}
```

The `MODEINITFLOAT` convergence branch at `newton-raphson.ts:589-605` already emits `ladder.onModeEnd("dcopInitFloat", ...)` on success. Extend it to also emit `ladder.onModeEnd("tranNR", ...)` when the cktMode is in a transient context (`isTran(ctx.cktMode) || isTranOp(ctx.cktMode)`). Use the existing mode predicates from `ckt-mode.ts`; do not re-decode bit patterns inline.

### Initial-mode emission for transient

For DC-OP, the ladder consumer in `dc-operating-point.ts` emits an initial `onModeBegin("dcopInitJct")` before NR starts (currently implicit in how the ladder is set up — verify in dc-operating-point.ts:321 area when implementing). For transient, the equivalent initial `onModeBegin("tranInit")` or `onModeBegin("tranPredictor")` must fire BEFORE the first NR iteration of the transient call.

Insertion point: `analog-engine.ts` at the site where the ladder is configured for transient. This is currently NOT configured (the `_seedFromDcop` and transient-step paths set `ctx.cktMode` directly without setting up a ladder). Add a small ladder-construction helper in the harness setup path (mirroring how `dc-operating-point.ts:161` does it) and emit:
- `onModeBegin("tranInit", 0)` when entering NR with `MODEINITTRAN` set
- `onModeBegin("tranPredictor", 0)` when entering NR with `MODEINITPRED` set

This emission is harness-only — production transient code leaves `nrModeLadder = null` and incurs no overhead.

### Harness consumer

`createStepCaptureHook` in `src/solver/analog/__tests__/harness/capture.ts` already routes `dcopModeLadder` events through `beginAttempt/endAttempt`. Extend the routing to handle the new tran phases. The mapping:

| Ladder event | beginAttempt phase | endAttempt outcome |
|---|---|---|
| `onModeBegin("tranInit", n)` | `"tranInit"` | (set on next `onModeEnd`) |
| `onModeEnd("tranInit", n, false)` | — | `"tranPhaseHandoff"` (new) |
| `onModeBegin("tranPredictor", n)` | `"tranPredictor"` | — |
| `onModeEnd("tranPredictor", n, false)` | — | `"tranPhaseHandoff"` |
| `onModeBegin("tranNR", n)` | `"tranNR"` | — |
| `onModeEnd("tranNR", n, true)` | — | `"accepted"` |

### New outcome string

Add `"tranPhaseHandoff"` to `NRAttemptOutcome` in `src/solver/analog/__tests__/harness/types.ts:284-287`. The bridge translates ngspice's intra-NIiter cktMode flips to its own `nrFailedRetry` / `dcopSubSolveConverged` outcomes today; update the bridge to also emit `tranPhaseHandoff` when the prior phase was `"tranInit"` or `"tranPredictor"` and the next phase is `"tranNR"` within the same step (`ngspice-bridge.ts:704-714`).

This keeps the outcome vocabulary aligned: DC-OP intra-NR transitions emit `dcopPhaseHandoff`, transient intra-NR transitions emit `tranPhaseHandoff`. `nrFailedRetry` reverts to its true meaning (the NR call returned non-converged and the outer driver is retrying).

## Files to change

| File | Change |
|---|---|
| `src/solver/analog/ckt-context.ts` | Rename `dcopModeLadder → nrModeLadder`. Widen phase union. |
| `src/solver/analog/newton-raphson.ts` | Read renamed field. Add ladder calls in INITTRAN/INITPRED branches. Extend MODEINITFLOAT-converged branch to emit `tranNR` end on transient mode. |
| `src/solver/analog/dc-operating-point.ts` | Update field references. (No semantic change.) |
| `src/solver/analog/analog-engine.ts` | Update production null-assignment site. Add harness-side ladder construction for transient NR calls. |
| `src/solver/analog/__tests__/harness/types.ts` | Add `"tranPhaseHandoff"` to `NRAttemptOutcome`. |
| `src/solver/analog/__tests__/harness/capture.ts` | Route new tran phases through `beginAttempt/endAttempt`. |
| `src/solver/analog/__tests__/harness/comparison-session.ts` | Wire the `nrModeLadder` for transient NR entries (currently only DC-OP path constructs one). |
| `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | Emit `"tranPhaseHandoff"` instead of `"nrFailedRetry"` for `tranInit→tranNR` and `tranPredictor→tranNR` intra-step transitions. |
| `src/solver/analog/__tests__/newton-raphson.test.ts` | Update three test fixtures using renamed field. |
| `src/solver/analog/__tests__/harness/ngspice-bridge-grouping.test.ts` | The `phase change → new attempt boundary` test at line 120 stays — this is the bridge's correct behavior. Add a new test asserting that `tranInit → tranNR` produces `tranPhaseHandoff` (not `nrFailedRetry`) as the outcome on the first attempt. |

## Test plan

1. **Existing tests**: full vitest run after rename. The three `newton-raphson.test.ts` fixtures must pass with renamed field; the existing bridge-grouping test must pass unchanged; phase-10 wave 10.1 (resistive divider DC-OP) and wave 10.2 (diode-resistor DC-OP) must remain bit-exact.

2. **New diagnostic**: `_diag-diode-resistor-tran.test.ts` (already in tree) — re-run after the change. Both engines should now report identical attempt structures: 5 attempts for step 0 (`dcopInitJct`, `dcopInitFix`, `dcopInitFloat`, `tranInit`, `tranNR`), 2 attempts for steps 1+ (`tranPredictor`, `tranNR`). Every per-iteration value remains bit-exact.

3. **Phase 10 wave 10.3** (RC transient): re-run `rc-transient.test.ts`. It currently passes by chance because it uses the same `attempts[ai] vs attempts[ai]` index-equality assertion that papered over the asymmetry on simpler circuits. After the fix, the assertion is stronger — both sides have the same number of attempts per step.

4. **Add an assertion-based transient parity test** for the diode-resistor circuit (promote `_diag-diode-resistor-tran.test.ts` from diagnostic dump to assertion form once green, or add a permanent `diode-resistor.test.ts::transient_match` analogous to `resistive-divider.test.ts::transient_per_step_match`). This makes the original Phase 10 oversight explicit going forward.

5. **Bridge grouping test extension**: assert that an injected sequence of `[MODEINITTRAN, MODEINITFLOAT]` raw iterations within one step produces an attempt with outcome `tranPhaseHandoff` followed by an attempt with outcome `accepted`, NOT `nrFailedRetry → accepted`.

## Acceptance criteria

- All existing tests pass after the rename and dispatcher extension.
- `_diag-diode-resistor-tran.test.ts` (or its promoted assertion form) passes with `absDelta === 0` on every per-iteration field AND identical attempt count per step on both sides.
- Production code (no harness) has zero new allocations and zero new function calls per NR iteration. The only added cost is one null check per INITF transition, matching the existing DC-OP pattern.
- No engine numerics change. No `cktMode` semantics change. No new ngspice DLL build required.
- The new outcome string `tranPhaseHandoff` is the only addition to `NRAttemptOutcome`. No banned vocabulary (`tolerance`, `mapping`, `pre-existing`, etc.) appears anywhere in the change.

## Non-goals

- Restructuring how the harness reconstructs attempts from raw iteration streams.
- Adding a tran-step LTE phase to the ladder.
- Renaming `nrModeLadder` to anything else after this rename (the rename here is the final name).
- Touching the ngspice DLL or its instrumentation. The DLL emission stream is already correct; only the bridge's outcome-string assignment needs updating.
