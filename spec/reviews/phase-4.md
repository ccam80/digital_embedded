# Review Report: Phase 4 — SimulationCoordinator

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | P4-1, P4-2, P4-3, P4-4, P4-5, P4-6, P4-7 |
| Violations — critical | 1 |
| Violations — major | 2 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 2 |
| Legacy references | 0 (MixedSignalCoordinator fully removed from src/) |
| Test results | 7496 passed / 4 failed (all 4 pre-existing submodule ENOENT) |
| Test delta | +10 new tests vs Phase 3 baseline (7486) |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Double compilation in DefaultSimulatorFacade.compile() (CRITICAL)

**File**: `src/headless/default-facade.ts`, lines 150–163

**Rule violated**: Performance / correctness — `compile()` calls `compileUnified()` to create a coordinator, then *also* calls `this._runner.compile(circuit)` on line 162, which internally calls `compileUnified()` a second time, creates a second `DefaultSimulationCoordinator`, and stores it in the runner's WeakMap. This means every facade `compile()` runs the full compilation pipeline **twice** and creates **two** independent coordinators with separate digital engines. The runner's coordinator is never used for stepping (the facade steps through its own coordinator), so label resolution in `runTests()` could theoretically diverge from the facade's simulation state.

**Evidence**:
```typescript
// default-facade.ts:150-163
const unified = compileUnified(circuit, this._registry, getTransistorModels());
const coordinator = new DefaultSimulationCoordinator(unified);
this._coordinator = coordinator;
// ...
// Also register with runner for runTests() label resolution
if (engineMode !== 'analog' && unified.digital !== null) {
  this._runner.compile(circuit);  // ← SECOND full compile
}
```

The runner's `compile()` (runner.ts:89–133) does its own `compileUnified()` + `new DefaultSimulationCoordinator(unified)`, creating an entirely separate engine instance.

**Impact**: 2x compile cost, 2x engine memory, potential state divergence between facade and runner coordinators during test execution.

**Fix**: Pass the already-created coordinator (or the `CompiledCircuitUnified`) to the runner instead of re-compiling. The runner needs a record in its WeakMap for `runTests()` label resolution — register the facade's coordinator directly.

**Severity**: critical

---

### V2 — Duplicate `getTransistorModels()` singleton (MAJOR)

**Files**: `src/headless/default-facade.ts` lines 52–61, `src/headless/runner.ts` lines 26–35

**Rule violated**: DRY — the exact same function with its own module-level `_transistorModels` cache is copy-pasted in both files. Each maintains a separate singleton, so models are registered twice. If a new model is added to one file but not the other, they silently diverge.

**Evidence**:
```typescript
// default-facade.ts:52-61 — identical code in runner.ts:26-35
let _transistorModels: TransistorModelRegistry | null = null;
function getTransistorModels(): TransistorModelRegistry {
  if (!_transistorModels) {
    _transistorModels = new TransistorModelRegistry();
    registerAllCmosGateModels(_transistorModels);
    registerCmosDFlipflop(_transistorModels);
    registerDarlingtonModels(_transistorModels);
  }
  return _transistorModels;
}
```

**Fix**: Extract to a shared module (e.g. `src/analog/default-models.ts`) and import in both files.

**Severity**: major

---

### V3 — Duplicate `PinDirection` import in coordinator test (MAJOR)

**File**: `src/compile/__tests__/coordinator.test.ts`, lines 11 and 15

**Rule violated**: Code hygiene — `PinDirection` is imported twice from the same module. Line 11 imports `{ PinDirection }`, then line 15 imports `{ PinDirection, resolvePins, createInverterConfig, createClockConfig }` — the latter three are unused.

**Evidence**:
```typescript
import { PinDirection } from '../../core/pin.js';           // line 11
import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from '../../core/pin.js';  // line 15
```

This is likely a merge artefact from the agent splicing code. The duplicate will cause a TypeScript error under strict `--isolatedModules` in some configurations, and the three extra imports (`resolvePins`, `createInverterConfig`, `createClockConfig`) are dead code.

**Severity**: major

---

### V4 — `as unknown as` escape hatches in facade and runner (MINOR)

**Files**: `src/headless/default-facade.ts` (3 occurrences), `src/headless/runner.ts` (5 occurrences)

**Rule violated**: Type safety — 8 total `as unknown as` casts exist in the facade/runner integration layer. These bypass TypeScript's type system entirely. The most concerning are:

1. **runner.ts:113-116** — casting `unified.analog` and coordinator to `Engine` for WeakMap keying. This works only because `Engine` is a base interface, but a `SimulationCoordinator` is *not* an `Engine`. The cast papers over a design gap where the WeakMap key type doesn't match what's actually stored.

2. **default-facade.ts:417-419** — casting `AnalogEngine` to `SimulationEngine`. These are distinct interfaces; the cast hides any method incompatibilities.

3. **default-facade.ts:388** — `analog as unknown as { lastDcOpResult?: DcOpResult }` is duck-typing a private implementation detail of MNAEngine.

These are transitional artifacts from Phase 4's "no public API changes" constraint, but they accumulate as type-safety debt.

**Severity**: minor (expected to be cleaned up in Phase 5 when return types change)

---

### V5 — `_thresholdVoltage` returns 0 for indeterminate band (MINOR)

**File**: `src/compile/coordinator.ts`, lines 421–428

**Rule violated**: Spec fidelity — The threshold function silently returns 0 when voltage is between V_IL and V_IH. The BridgeInstance path (lines 229–254) correctly handles indeterminate voltages with hysteresis tracking, diagnostic emission after 10 consecutive indeterminate steps, and fallback to the previous bit value. The BridgeAdapter path (top-level `_stepMixed`) has none of this — it just maps indeterminate to 0.

**Evidence**:
```typescript
private _thresholdVoltage(voltage: number, bridge: BridgeAdapter): number {
  const spec = bridge.electricalSpec;
  const vIH = spec.vIH ?? 2.0;
  const vIL = spec.vIL ?? 0.8;
  if (voltage >= vIH) return 1;
  if (voltage <= vIL) return 0;
  return 0;  // ← no hysteresis, no diagnostic
}
```

**Impact**: Low for now (BridgeAdapter path is used for top-level mixed circuits which are rare), but this will be the primary path once BridgeInstance is phased out.

**Severity**: minor

---

### V6 — `_getAnalogVoltages` allocates a new `Float64Array` per call (MINOR)

**File**: `src/compile/coordinator.ts`, lines 453–462

**Rule violated**: Performance — `_getAnalogVoltages()` is called twice per mixed-signal step (once in `_syncBeforeAnalogStep`, once in `_syncAfterAnalogStep`). Each call allocates a new `Float64Array(matrixSize)` and fills it with `getNodeVoltage()` calls. For a circuit with many nodes, this creates GC pressure on every step.

**Evidence**:
```typescript
private _getAnalogVoltages(): Float64Array {
  const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
  const size = compiledAnalog.matrixSize;
  const voltages = new Float64Array(size);  // ← allocation per call
  for (let i = 0; i < compiledAnalog.nodeCount; i++) {
    voltages[i] = analog.getNodeVoltage(i + 1);
  }
  return voltages;
}
```

**Fix**: Pre-allocate the array in the constructor and reuse it.

**Severity**: minor

---

## Gaps

### G1 — No mixed-signal integration test through the coordinator

**Spec requirement**: P4-3 calls for tests covering bridge sync between digital and analog backends. The spec also says P4-2 should fold MixedSignalCoordinator's bridge-sync logic.

**What was found**: The coordinator test file (`src/compile/__tests__/coordinator.test.ts`) has 16 tests: 13 digital-only and 3 analog-only. There are **zero** tests for a mixed-signal circuit through the coordinator. The bridge sync logic in `_stepMixed()`, `_syncBeforeAnalogStep()`, and `_syncAfterAnalogStep()` (lines 155–371 — over 200 lines of bridge sync logic) is entirely untested via the new coordinator path.

The old `mixed-signal-coordinator.test.ts` was deleted (334 lines). Its test coverage was not migrated to the new coordinator tests.

**Risk**: The most complex code path in the coordinator has zero test coverage.

---

### G2 — Facade `compile()` return type changed from `SimulationEngine` to `SimulationCoordinator`

**Spec requirement**: P4-4 states: "The facade's public API signatures (returning SimulationEngine, accepting raw numbers) must NOT change in Phase 4. Phase 5 will update these."

**What was found**: `SimulatorFacade.compile()` (facade.ts:89) now returns `SimulationCoordinator`:
```typescript
compile(circuit: Circuit): SimulationCoordinator;
```

The spec explicitly says this signature change should wait for Phase 5. The `step()`, `run()`, `runToStable()`, `setInput()`, `readOutput()`, and `readAllSignals()` methods also changed their first parameter from `SimulationEngine` to `SimulationCoordinator | SimulationEngine`.

This is pragmatic (avoids double-wrapping), but it's an explicit spec deviation. All consumers that call `facade.compile()` expecting a `SimulationEngine` now get a `SimulationCoordinator`.

---

## Weak Tests

### WT1 — Analog tests bail out with early `return` instead of failing

**Test path**: `src/compile/__tests__/coordinator.test.ts`, lines 439/449/458

**Problem**: All three analog-only tests guard with `if (unified.analog === null) return;`. If the analog compilation path is broken and returns null, these tests silently pass instead of failing. The guard should be an assertion:

```typescript
// Current (silently passes if analog compilation is broken):
if (unified.analog === null) return;

// Should be:
expect(unified.analog).not.toBeNull();
```

---

### WT2 — No negative-path test for `writeSignal` with mismatched SignalValue type

**Test path**: `src/compile/__tests__/coordinator.test.ts`

**Problem**: There's a test for writing analog to a digital-only coordinator (line 398), but no test for writing a `{ type: 'analog', voltage: 1.0 }` SignalValue to a digital address. The `writeSignal` method (coordinator.ts:386) has a guard for this: `if (value.type !== 'digital') throw new FacadeError(...)`, but it's untested.

---

## Architecture Assessment

### What Phase 4 got right

1. **Clean interface extraction**: `SimulationCoordinator` (coordinator-types.ts) is a well-designed interface — 68 lines, clear contract, proper JSDoc. It correctly abstracts over digital-only, analog-only, and mixed-signal modes.

2. **MixedSignalCoordinator removal**: Zero remaining references in `src/`. The deletion was clean — no orphaned imports or dead code left behind.

3. **Bridge sync preservation**: The complex bridge sync logic from MixedSignalCoordinator was faithfully ported to DefaultSimulationCoordinator, including BridgeInstance adapter handling, threshold detection with hysteresis tracking, oscillation detection, and diagnostic emission.

4. **Observer pattern**: Clean implementation with proper `Set<MeasurementObserver>`, step counting, and reset notification.

5. **Test count**: +10 net new tests, no regressions beyond pre-existing submodule failures.

### What needs attention before Phase 5

1. **Fix double compilation** (V1) — this is the highest-priority item. It's wasted work and a state-divergence risk.
2. **Add mixed-signal coordinator tests** (G1) — the bridge sync code is the coordinator's raison d'etre and has zero coverage through the new path.
3. **Fix duplicate import** (V3) — trivial but will break under certain TS configs.
4. **Extract shared `getTransistorModels()`** (V2) — prevents silent divergence.
