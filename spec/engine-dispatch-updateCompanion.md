# Spec: Engine dispatch of `updateCompanion` on behavioral elements

## Problem

`MNAEngine.step()` in `src/solver/analog/analog-engine.ts` dispatches exactly
two per-element hooks across the element list:

1. **`stampCompanion(dt, method, voltages)`** — stamped before every NR pass
   on reactive elements (`el.isReactive && el.stampCompanion`). Lines 258–262,
   292–294, 370–372.
2. **`updateState(dt, voltages)`** — called once per accepted timestep on any
   element that defines it. Lines 464–468.

It does **not** call `updateCompanion(dt, method, voltages)` on elements. The
only references to `updateCompanion` anywhere in `src/solver/analog/` that run
through the engine path are pin-model calls *inside* an element's own
`updateCompanion` (for its child pin models). There is no element-level
dispatch site.

## Impact

Several behavioral elements put logic that must run once per accepted timestep
into `updateCompanion` and leave `updateState` as an intentional no-op:

| File | `updateCompanion` role | `updateState` |
|---|---|---|
| `behavioral-flipflop.ts:196` (D FF) | Rising-edge detection, D sampling, async set/reset, pin companion updates | No-op (`:259`) |
| `behavioral-flipflop/d-async.ts:106` | Same pattern | No-op (`:159`) |
| `behavioral-flipflop/jk.ts:102` | JK edge detection | No-op (`:151`) |
| `behavioral-flipflop/jk-async.ts:110` | JK + async set/reset | No-op (`:175`) |
| `behavioral-flipflop/rs.ts:111` | RS latch | No-op (`:173`) |
| `behavioral-flipflop/rs-async.ts:100` | RS + async | No-op (`:149`) |
| `behavioral-flipflop/t.ts:98` | T toggle edge detection | No-op (`:141`) |
| `behavioral-sequential.ts:178, :365, :674` (counter / register / up-down) | Edge detection, enable/dir/load/clr sampling, pin companion updates | (assumed no-op — verify in fix) |
| `behavioral-combinational.ts:151, :295, :420` | Input + output pin companion updates | (verify) |
| `behavioral-gate.ts:223` | Input + output pin companion updates | (verify) |

Through the real engine path, none of this logic fires. The symptom for D/JK/T
flip-flops is that `_latchedQ` never leaves its initial `false` state, `_prev*`
voltages stay at zero, and pin capacitor companion models degrade because pin
`_prevVoltage` / `_prevCurrent` are frozen.

The existing unit tests pass because they bypass the engine dispatch: e.g.
`behavioral-integration.test.ts:445` (`behavioral_dff_toggle`) calls
`element.updateCompanion(...)` directly on the element instance instead of
going through `engine.step()`.

## Failing tests (added ahead of fix)

`src/solver/analog/__tests__/behavioral-flipflop-engine-dispatch.test.ts`:

1. **`latches D=HIGH through engine.step() when clock rises`** — Builds a real
   MNA circuit with `makeVoltageSource` for clock and D. Starts with clock
   LOW, runs `engine.dcOperatingPoint()` + `engine.step()`, then pulses the
   clock HIGH via `setSourceScale(1)` and calls `engine.step()` twice. Asserts
   `qPin.currentVoltage > vIH` after the edge.
2. **`toggles Q across four clock edges via engine.step()`** — Repeated rise /
   fall pulses with alternating D, asserting Q tracks D on every rising edge.
3. **`does not latch without a rising clock edge (clock held HIGH)`** —
   Negative check: clock raised before DC op and never toggles; Q must stay
   LOW through ten transient steps. Guards against a naive fix that falsely
   fires an edge on the first `updateCompanion` call.

All three fail today because `_latchedQ` never changes.

## Fix

Add a new dispatch loop in `MNAEngine.step()` for `updateCompanion`, parallel
to the existing `updateState` loop.

### Placement

Immediately **before** the `updateState` loop at `analog-engine.ts:464-468`,
once the timestep has been fully accepted (post state-pool commit, post
`this._simTime` advance, post `timeRef` update). At this point `_voltages`
holds the accepted NR solution for the current timestep and `dt` holds the
accepted step size.

### Proposed change

```ts
// Run edge-detection / pin-companion updates for elements that need accepted
// solution voltages. This must run exactly once per accepted timestep — NOT
// per NR iteration — so elements can safely detect rising/falling edges
// without mid-NR false triggers.
for (const el of elements) {
  if (el.updateCompanion) {
    el.updateCompanion(dt, method, this._voltages);
  }
}

// Update non-MNA state for elements that track it
for (const el of elements) {
  if (el.updateState) {
    el.updateState(dt, this._voltages);
  }
}
```

Ordering rationale: `updateCompanion` runs first so that elements that use it
for edge detection set their latched state before any `updateState` consumer
reads it. No current element depends on the reverse order.

### Element interface addition

`AnalogElement` (and `AnalogElementCore`) in `src/solver/analog/element.ts`
must declare `updateCompanion` as an optional member:

```ts
updateCompanion?(
  dt: number,
  method: IntegrationMethod,
  voltages: Readonly<Float64Array>,
): void;
```

Type should accept `Readonly<Float64Array>` to match the existing
`updateState` / `updateOperatingPoint` convention per the W6T1 migration
(commit `0784b59`). Update any element implementations that currently type
`voltages` as a mutable `Float64Array` to match.

### Semantics to preserve

- **Exactly once per accepted timestep.** Never on a rejected LTE retry (the
  rejected step's state was restored). Never during NR retries inside the
  convergence recovery loop.
- **After `_voltages` is committed** and `simTime` has advanced — so elements
  observe `(simTime, dt)` pairs that match the accepted solution.
- **After `statePool.acceptTimestep()`** so any state pool swaps are visible.
- **Before measurement observer notification** (`_stepCount++` / `onStep`) so
  observers see post-edge latched state.
- **DC operating point path is not affected.** `dcOperatingPoint` does not run
  transient steps and does not call `updateCompanion`. The first transient
  `step()` call will see `_prevClockVoltage = 0` (the element's construction
  default). This is consistent with current behavior and is covered by the
  third failing test (clock-held-HIGH does not produce a false edge because
  the first dispatch sets `_prevClockVoltage` = current HIGH voltage, and no
  subsequent step sees a LOW→HIGH transition).

### Out of scope for this spec

- Whether `updateCompanion` should also be dispatched once at the end of
  `dcOperatingPoint()` to seed `_prev*` from the DC solution. The current
  tests do not require it and the behavior under a hot-from-DC clock matches
  the existing `_prevClockVoltage = 0` initial convention.
- Consolidating `updateCompanion` and `updateState` into a single element
  hook. They have different semantics today (companion vs. non-MNA state) and
  some elements implement one but not the other.
- Per-element audit of whether `isReactive` should gate `updateCompanion`
  dispatch. The flipflops are marked `isReactive = true` so a gated dispatch
  would also work, but unconditional dispatch is simpler, matches
  `updateState`'s pattern, and costs one `if (el.updateCompanion)` check per
  element per step.

## Verification

After applying the fix:

1. `npm run test:q -- behavioral-flipflop-engine-dispatch` — all three new
   tests must pass.
2. `npm run test:q -- src/solver/analog/__tests__` — existing behavioral,
   flipflop, sequential, and integration tests must remain green. Special
   attention to `behavioral_dff_toggle` in `behavioral-integration.test.ts`,
   which still calls `element.updateCompanion(...)` directly — that path
   remains valid; it should now also work when driven purely via
   `engine.step()`.
3. `npm test` — full suite, including `src/headless/__tests__/` end-to-end
   paths that go through `DefaultSimulationCoordinator` and the coordinator
   bridge for mixed-signal circuits.
4. Manual spot check: an analog-domain circuit containing a D flip-flop with
   its model set to `behavioral` should correctly latch through the MCP
   `circuit_step` path (not covered by automated tests at time of writing).
