# convergence-regression: StatePool direct-read migration

## Category

`contract-update`

## Problem

`src/solver/analog/__tests__/convergence-regression.test.ts` builds element arrays out of band (assembling `ConcreteCompiledAnalogCircuit` from inline factory output and a manually allocated `StatePool` via `allocateStatePool`), then reads the live diode `_stateBase` and indexes raw `pool.state0[...]` / `pool.state1[...]` / `pool.state2[...]` to assert per-slot values. Two surfaces are now wrong against the production engine contract:

1. The hand-rolled compiled-circuit object is shaped well enough to pass `engine.init()` but skips the `_setup()` plumbing that `DefaultSimulatorFacade.compile()` runs. As a result `dcOperatingPoint()` returns `converged === false` (observed in three of the five tests) and the diode never reaches its forward operating point, so `pool.state0[diodeBase + 0]` stays at zero. Hand-assembling a `ConcreteCompiledAnalogCircuit` is not a supported contract; the engine has hardened to require facade-compiled input.
2. Reading `pool.state0[base + slotIndex]` reaches into the per-element internal pool layout. The harness now provides `captureElementStates(elements, pool)` (in `src/solver/analog/__tests__/harness/capture.ts:189`) which returns a per-element `ElementStateSnapshot[]` keyed by slot name from the element's `stateSchema`. The slot-name lookup is the supported way to inspect device state from outside the engine.

## Failing tests / sites

`src/solver/analog/__tests__/convergence-regression.test.ts`:

| Test | Lines | Failure |
|------|-------|---------|
| `half-wave rectifier converges and diode forward voltage is correct` | 141-154 | `expect(result.converged).toBe(true)` — false |
| `statePool state0 has non-zero values after DC operating point` | 187-212 | DC fails to converge; `pool.state0[diodeBase + 1]` checks blocked |
| `statePool state1 is updated after accepted transient step` | 218-240 | `state1VdAfterDc` is 0 (DC didn't converge so nothing rotated into state1) |
| `diode circuit runs 100 transient steps without error` | 246-263 | engine state goes to ERROR because the hand-rolled circuit fails DC |
| `reset restores initial values in statePool` | 269-286 | `pool.state0[diodeBase + 0]` is 0 before reset because DC didn't run |

The first inline element-assembly site (which all five tests share) is at `convergence-regression.test.ts:69-124` (`makeHalfWaveRectifier` and `makeRCCircuit`).

## Migration

Replace the inline `makeHalfWaveRectifier()` / `makeRCCircuit()` builders with facade-compiled fixtures, and replace direct `pool.state0[diodeBase + N]` reads with named-slot `captureElementStates()` lookups.

### Fixture replacement

The `harness-integration.test.ts` cluster already uses `buildHwrFixture()` (`src/solver/analog/__tests__/harness/hwr-fixture.ts`) which returns `{ circuit, pool, engine }` from a facade-compiled VS→R→D circuit. Every test in this file's HWR fixture call site swaps to that helper. For the RC fixture, define an analogous `buildRcFixture()` (in the same harness folder, not in this test file) that compiles VS=5V → R=1kΩ → C=1µF → GND through the facade.

Before:
```ts
const { circuit, pool } = makeHalfWaveRectifier();
engine.init(circuit);
```

After:
```ts
const { circuit, pool, engine } = buildHwrFixture();
```

The fresh `MNAEngine` from `beforeEach` is no longer used; the fixture supplies the engine that already owns the compiled circuit and statePool. `beforeEach` is removed from this describe block.

### State-pool read replacement

For each `pool.state0[diodeBase + N]` / `pool.state1[diodeBase + N]` / `pool.state2[diodeBase + N]` site, substitute a `captureElementStates` lookup. The diode's pool-backed slot names are `VD` and `GEQ` (per the diode's `stateSchema` registered in `src/components/semiconductors/diode.ts`).

Concrete substitutions, by test:

#### `statePool state0 has non-zero values after DC operating point` (lines 187-212)

| Old | New |
|-----|-----|
| `pool.state0[diodeBase + 1]` (pre-DC GMIN seed) | `captureElementStates(circuit.elements, pool).find(s => s.label === "d1")!.state0.GEQ` |
| `pool.state0[diodeBase + 0]` (post-DC VD) | `captureElementStates(...).find(s => s.label === "d1")!.state0.VD` |
| `pool.state0[diodeBase + 1]` (post-DC GEQ) | `captureElementStates(...).find(s => s.label === "d1")!.state0.GEQ` |

Drop the `diodeEl._stateBase` lookup entirely — `_stateBase` is internal pool plumbing.

#### `statePool state1 is updated after accepted transient step` (lines 218-240)

| Old | New |
|-----|-----|
| `pool.state1[diodeBase + 0]` | `captureElementStates(circuit.elements, pool).find(s => s.label === "d1")!.state1.VD` |

#### `reset restores initial values in statePool` (lines 269-286)

| Old | New |
|-----|-----|
| `pool.state0[diodeBase + 0]` | `captureElementStates(...).find(s => s.label === "d1")!.state0.VD` |
| `pool.state1[diodeBase + 0]` | `captureElementStates(...).find(s => s.label === "d1")!.state1.VD` |
| `pool.state2[diodeBase + 0]` | `captureElementStates(...).find(s => s.label === "d1")!.state2.VD` |

Tests `half-wave rectifier converges` and `RC circuit runs transient steps stably` and `diode circuit runs 100 transient steps without error` only assert via `engine.dcOperatingPoint()` / `engine.getNodeVoltage(2)` / `engine.getState()` — the only change for these is the fixture swap. Once the fixture is facade-compiled the convergence behaviour matches production.

## ngspice citation

These tests do not assert ngspice-bit-exact values; they assert that the engine drives the state pool through DCOP and accepted transient steps. No ngspice citation is required for the tests themselves. The diode forward-drop range `(0.55, 0.80)` V is a coarse physical-plausibility check, not a numerical-parity check.

## Tensions / uncertainties

- `captureElementStates` returns an `ElementStateSnapshot[]` keyed by element index, not by label. The snapshot does carry an `ElementStateSnapshot.label` field (populated from the optional `elementLabels` map). Verify that without supplying `elementLabels`, the snapshot's `label` field falls back to `el.label ?? "element_<index>"`. If it does not, the migration uses `snapshots[diodeIndex]` keyed by element-array index instead of label. The diode is element index 2 in the HWR fixture (`vs`, `r1`, `d1`).
- The current test relies on direct write-through behaviour of `pool.state0` / `pool.state1` / `pool.state2`. `captureElementStates` reads only — it does not mirror writes. Since these tests only read, this is fine. Flag if a future migration of a test that *writes* to the pool (none in this cluster) needs a different surface.
- One escalation candidate: the existing tests look for the GMIN seed (1e-12) in state0 *before* DC-OP runs. After the fixture swap, the engine has already been initialised by the facade; whether the GMIN seed value is still observable before the first `dcOperatingPoint()` call depends on when `_setup()` runs in the facade-compile path. If the seed is consumed before the test can observe it, the assertion `expect(captured.state0.GEQ).toBeGreaterThan(0)` may need to be moved to *after* DC-OP completes (where it currently passes anyway). This is a sequencing observation, not a contract gap.
