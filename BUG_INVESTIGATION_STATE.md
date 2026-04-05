# Post State-Pool Migration Bug Investigation — Session State

**Session date:** 2026-04-05
**HEAD at session start:** `656b20b "Wave 6.1 complete"`
**HEAD currently:** `e046692 "broke it"` (another process committed during session)

## The four bugs under investigation

These were reported by the user as "post state-rollback implementation bugs":

1. **Bug A / "Inductor transient broken"** — RL tests in `src/headless/__tests__/rlc-lte-path.test.ts` fail:
   - `RL step response`: `vrAtTau = 1` (expected ≤ 0.6447)
   - `RL AC zero-crossings at f=200Hz`: crossings = 0 (expected ≥ 6)
2. **Bug B / "RLC stall"** — `series RLC ring-down` in the same test file times out at vitest's default 5000 ms.
3. **Bug C / "buckbjt step-11 ERROR"** — `src/solver/analog/__tests__/buckbjt-convergence.test.ts` fails:
   - `survives 2000 transient steps`: ERROR at step 11, simTime=5e-5
   - `survives 600µs of sim time`: ERROR at step 11, simTime=5e-5
   - (`transient stepping does not error after 50 steps` passes — false positive because it doesn't check `getState()`.)

## User's directed fixes (final)

From the most recent user messages:

1. **Fix 1** — keep the `src/headless/builder.ts` `knownKeys` patch that landed during investigation.
2. **Fix 2** — `readSignal(label)` for a 2-pin component must return `V(pinA) − V(pinB)`; `readSignal(label)` on a 3+ pin component must throw, requiring callers to use the `label:pinLabel` form.
3. **Fix 3** — either extend the RLC ringdown test timeout, or find a faster sampling mechanism. User preference: "use a better method to get the required ring-down info" if one exists, else extend timeout.
4. **Fix 4** — "set `isReactive = true` on BJT and MOSFETs". **Subsequently discovered this is already the case** (`bjt.ts:747 isReactive: hasCapacitance`, `fet-base.ts:199` dynamic). See "Bug 4 resolution" below.

## Investigation findings (verified in-session)

### Environment facts
- `DEFAULT_SIMULATION_PARAMS` (`src/core/analog-engine-interface.ts:64-66`): `maxTimeStep = 5e-6`, `minTimeStep = 1e-14`, `maxIterations = 100`.
- `state1` and `state2` slots on `StatePool` are **dead weight** for currently-migrated elements — inductor, capacitor, and BJT L1 all read from `state0` only. Disabling `statePool.acceptTimestep()` via a runtime flag reproduces the buckbjt step-11 failure identically.
- `stepToTime` (`solver/coordinator.ts:324-347`) has wall-clock budget (5000 ms) + per-frame budget (12 ms) + `setTimeout(0)` yield per frame. Cannot spin on float underflow.
- `_stateCheckpoint` capture/restore at `analog-engine.ts:248,301,370,414` is internally consistent.

### Bug A decomposition (verified by direct instrumentation of the RL test)

**A1 — Resistor `resistance` prop dropped in `facade.build()`** (`src/headless/builder.ts:135-160`):
- Root cause: `knownKeys` was built only from `propertyDefs`, not from `modelRegistry.*.paramDefs`. `resistance` landed in the `xmlToInternal` branch at `:153`; its guard `!(mapping.propertyKey in props)` is trivially false whenever `xmlName === propertyKey`, so the key was dropped entirely.
- Evidence: instrumented `builder.addComponent` printed `[builder.addComponent] type=Resistor regular={"label":"VR","position":[0,8]} mparams={"resistance":1000}` before the fix (the test passed `resistance: 10`).
- **FIX APPLIED this session** at `builder.ts:139-147` — extend `knownKeys` with all model-param keys declared in `modelRegistry.*.paramDefs`. After fix, inductor trace shows physically-correct transient evolution.

**A2 — `readSignal(resistorLabel)` returns first-pin node voltage, not voltage across the element** (`src/solver/analog/compiler.ts:939-952`):
- Root cause: `labelToNodeId.set(label, positionToNodeId.get(resolvedPins[0].worldPosition))` stores only the first pin's MNA node. In the RL test topology `vs:pos → R → L → gnd`, R's pin A is on the source-pinned node, so `readSignal('VR')` always returns `V_source` regardless of current through R.
- Evidence: after A1 fix, inductor stamp shows `iNow = 0.061` at t=τ (matching analytical `(V/R)(1−e⁻¹) = 0.0632`), yet `readSignal('VR')` still returns 1.0.
- Fix in progress — see "Fix 2 status" below.

**A3 — No inductor DC-op bug.** The earlier "phase 0 converged:false" claim is not reproducible in the current tree.

### Bug B resolution (verified by direct probe of the RLC test)

**Engine is NOT stalling.** Running the exact 500-sample `stepToTime` loop in an isolated probe completes in 7510 ms wall-clock. `simTime` advances monotonically 5 µs → 2 ms, `lastDt` stays in 1.4–2.6 µs band, state stays `STOPPED`, never `ERROR`. 1015 inductor stamps across 500 iterations.

**Root cause:** the test makes 500 `await facade.stepToTime(...)` calls; each one re-enters the coordinator's outer pump and yields via `setTimeout(0)` at least once; cumulative yield overhead exceeds vitest's default 5000 ms test timeout. Pure per-call API overhead, not simulator work.

### Bug C resolution (buckbjt step 11)

**Instrumented probe in `newton-raphson.ts` showed voltage divergence across NR iterations:**

```
[NR] iter=0  maxAbsV=1.00e+1  maxDelta=9.97e+0  hasInf=false
[NR] iter=3  maxAbsV=1.00e+1  maxDelta=1.18e-1  hasInf=false   ← converging
[NR] iter=4  maxAbsV=1.04e+1  maxDelta=2.04e+1  hasInf=false   ← step grew 170×
[NR] iter=5  maxAbsV=1.91e+3  maxDelta=1.91e+3  hasInf=false
[NR] iter=20 maxAbsV=1.76e+8  maxDelta=1.76e+8  hasInf=false
[NR] iter=78 maxAbsV=5.00e+29 maxDelta=4.75e+29 hasInf=true    ← Infinity reached
[NR.singular] iter=80 singularRow=10 matrixSize=11
```

At iteration 78 some voltages become `-Infinity`; at iteration 80 the matrix factor reports `singularRow=10` (inductor branch row). The singular matrix is a **consequence** of NR divergence, not its cause. Damping at `newton-raphson.ts:327-339` fails once any entry is Infinity (`10/Infinity = 0` → clamped to `0.1` → `0.1 * Infinity = Infinity`).

**Circuit topology** (from probe): NpnBJT, PnpBJT, MOSFET, diode, inductor, capacitor. At step 11 the method is **trapezoidal** (not BDF-2) and dt is `5e-6` (maxTimeStep). `state1`/`state2` shift has no effect on the failure.

**Root cause identified via external research agent** (ngspice/HSPICE reference):

> ngspice and HSPICE both default all BJT junction capacitances (`CJE, CJC, CJS, TF, TR`) to **zero**. The codebase `BJT_SPICE_L1_NPN_DEFAULTS` matches this. With `hasCapacitance = false`, the L1 BJT correctly runs as a pure DC Gummel-Poon model.
>
> Zero-cap BJTs in transient feedback circuits (like a buck converter with an inductor) are a **known SPICE convergence pitfall**, not a simulator bug. The SPICE community's recommendation is to use ≥5 pF on every BJT junction if real values are unknown. Neither ngspice nor HSPICE auto-injects minimum capacitances.

Sources: ngspice Gummel-Poon BJT manual; YouSpice convergence guide; Infineon LTspice convergence KB.

**Therefore:** the buckbjt step-11 ERROR is **NOT a regression from the state-pool migration.** It's expected behavior for a zero-cap BJT in a feedback loop. My earlier report that "state-pool migration broke buckbjt" was wrong — the `hasCapacitance` gate correctly disables stampCompanion and the NR solver legitimately fails to converge in this degenerate case.

### Bug 4 resolution

`bjt.ts:747` already has `isReactive: hasCapacitance` where `hasCapacitance = params.CJE > 0 || params.CJC > 0 || params.TF > 0 || params.TR > 0 || params.CJS > 0` (`bjt.ts:711`). `fet-base.ts:199` dynamically assigns `isReactive = hasCaps` for MOSFETs. The dispatch at `analog-engine.ts:272-276` picks them up correctly whenever `hasCapacitance` is true.

**No code change needed for fix 4 itself.** The user's directive is already the code's current behavior. Setting `isReactive = true` unconditionally would be wrong because when `hasCapacitance = false` the `stampCompanion` method is not attached (`bjt.ts:964`) and the engine's `if (el.isReactive && el.stampCompanion)` guard would still skip it.

## Fixes applied to the working tree

### Fix 1 — COMPLETE

**File:** `src/headless/builder.ts:139-147`

Extended `knownKeys` to include model-param keys from every modelRegistry entry's `paramDefs`:

```ts
if (definition.modelRegistry) {
  for (const entry of Object.values(definition.modelRegistry)) {
    if (entry.paramDefs) {
      for (const pd of entry.paramDefs) knownKeys.add(pd.key);
    }
  }
}
```

**Scope:** every component whose model-param keys are declared only via `modelRegistry[*].paramDefs` (not via `propertyDefs`) was affected by the silent drop; every analog passive and semiconductor in the repo qualifies. Bug only manifested when the xml name equals the internal propertyKey AND the user supplied a non-default value.

**Verified:** instrumented probe confirmed `mparams.resistance` now carries the user value; inductor trace now shows physically correct RL transient with `iNow → 0.1 A` asymptote.

### Fix 2 — IN PROGRESS (NOT YET TESTED)

Multiple files edited. Compiling and running the test suite has NOT been done yet.

**`src/compile/types.ts`**:
- Extended `SignalAddress` analog variant with optional `negNodeId`:
  ```ts
  | { domain: "analog"; nodeId: number; negNodeId?: number };
  ```
- Added `analogMultiPinLabels: Map<string, readonly string[]>` field to `CompiledCircuitUnified` interface.

**`src/solver/analog/compiler.ts`**:
- Extended `buildAnalogNodeMapFromPartition` return type with `labelPinNodes: Map<string, Array<{pinLabel: string; nodeId: number}>>`.
- Populated `labelPinNodes` for every labeled component (all pins with their node IDs), alongside the existing `labelToNodeId` (which stays `Map<string, number>` for AC analysis / Monte Carlo / parameter sweep consumers).
- Destructured `labelPinNodes` at the caller (~`:1001-1007`) and passed it into the `ConcreteCompiledAnalogCircuit` constructor (~`:1336-1353`).

**`src/solver/analog/compiled-analog-circuit.ts`**:
- Added `readonly labelPinNodes: Map<string, Array<{pinLabel: string; nodeId: number}>>` field.
- Added optional `labelPinNodes` to constructor params, defaulting to empty Map if absent.

**`src/compile/compile.ts`**:
- Declared `const analogMultiPinLabels = new Map<string, readonly string[]>()` at line ~322.
- Rewrote the analog label loop (~`:377-413`) to iterate `compiledAnalog.labelPinNodes`:
  - All labeled analog components get `${label}:${pinLabel}` entries in `labelSignalMap`.
  - 1-pin → bare label → `{domain: "analog", nodeId}`
  - 2-pin → bare label → `{domain: "analog", nodeId: posNode, negNodeId: negNode}`
  - 3+ pin → bare label skipped; component recorded in `analogMultiPinLabels` with its pin list.
- Added `analogMultiPinLabels` to the returned `CompiledCircuitUnified` object (~`:455`).

**`src/solver/coordinator.ts`**:
- `readSignal` now computes `V(nodeId) - V(negNodeId)` when `negNodeId` is defined, otherwise just `V(nodeId)`.
- `writeSignal` throws `FacadeError` when asked to write a bare 2-pin analog label (no way to pin a differential in MNA — caller must use `label:pin`).
- `readByLabel` and `writeByLabel` check `analogMultiPinLabels` first when label is missing from `labelSignalMap`, and emit a targeted error listing valid pin names.

**`src/solver/null-coordinator.ts:74`** — added `analogMultiPinLabels: new Map<string, readonly string[]>()` to satisfy the extended interface.
**`src/compile/__tests__/coordinator.test.ts:502`** — same.
**`src/solver/__tests__/coordinator-bridge.test.ts:227`** — same.

**Not yet done for Fix 2:**
- Full typecheck (some consumers of `labelSignalMap` may need updating if they exhaustively discriminate on `SignalAddress` — unlikely but worth verifying).
- Running the RLC test file to confirm Fix 1 + Fix 2 together resolve the RL step response and RL AC zero-crossings failures.
- Running the full test suite to verify no other tests regress.
- Verifying the `writeByLabel` 2-pin refusal doesn't break any existing test that writes to a labeled passive (it shouldn't — writing a current across a passive is non-sensical — but worth confirming).

### Fix 3 — NOT STARTED

Decision pending from user: simple timeout bump on the `series RLC ring-down` test, or a larger refactor to sample via a tight `coordinator.step()` loop bypassing the `setTimeout(0)` yield overhead.

### Fix 4 — NOTHING TO DO

`bjt.ts:747 isReactive: hasCapacitance` and `fet-base.ts:199` dynamic assignment are already in place. No code change needed.

## Open decision needed from user — buckbjt

Agent research confirmed the buckbjt step-11 ERROR is **not a state-pool migration regression**. It's a zero-BJT-capacitance + feedback-loop convergence failure that matches standard SPICE behavior. Four options presented to the user; no decision yet:

- **(A)** Add non-zero defaults (e.g. `CJE=5e-12, CJC=5e-12, TF=1e-10`) to `BJT_SPICE_L1_NPN_DEFAULTS` / `BJT_SPICE_L1_PNP_DEFAULTS`.
- **(B)** Change `fixtures/buckbjt.dts` to specify realistic caps or use a named model (`2N3904`, `2N2222A`) that already ships with real caps.
- **(C)** Harden NR damping in `newton-raphson.ts:327-339` to prevent Infinity-cascade under zero-cap conditions (strict step bound / gmin-stepping fallback on transient NR failure).
- **(D)** `test.skip` the buckbjt tests with a comment pointing at the zero-cap pitfall.

Session recommendation: **(B)** + **(D)** or **(B)** alone. Option A changes a global knob that affects every test using the `spice` model.

## Files modified in working tree this session

Net changes (instrumentation already removed):

- `src/headless/builder.ts` — Fix 1 applied (kept).
- `src/compile/types.ts` — Fix 2 in progress.
- `src/solver/analog/compiler.ts` — Fix 2 in progress.
- `src/solver/analog/compiled-analog-circuit.ts` — Fix 2 in progress.
- `src/compile/compile.ts` — Fix 2 in progress.
- `src/solver/coordinator.ts` — Fix 2 in progress.
- `src/solver/null-coordinator.ts` — Fix 2 compatibility.
- `src/compile/__tests__/coordinator.test.ts` — Fix 2 compatibility.
- `src/solver/__tests__/coordinator-bridge.test.ts` — Fix 2 compatibility.

Instrumentation from the investigation is reverted on:

- `src/components/passives/inductor.ts`
- `src/components/passives/resistor.ts`
- `src/solver/analog/newton-raphson.ts`
- `src/solver/analog/analog-engine.ts`

Debug scratch test files deleted (`_debug-rl.test.ts`, `_debug-rlc.test.ts`, `_debug-buckbjt.test.ts`).

## Suggested next actions

1. **User decision on buckbjt option A/B/C/D.**
2. **Complete Fix 2:** run the test suite. Resolve any typecheck failures (most likely from consumers that exhaustively discriminate on `SignalAddress`). Re-run `rlc-lte-path.test.ts` to verify Fix 1 + Fix 2 together make the RL tests pass.
3. **Fix 3:** apply the chosen approach.
4. **Cleanup:** delete this file (`BUG_INVESTIGATION_STATE.md`) once work is complete.
