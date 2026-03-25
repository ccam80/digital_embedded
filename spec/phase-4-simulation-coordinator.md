# Phase 4: SimulationCoordinator

**Goal**: One coordinator replaces separate engine handling. `SimulationCoordinator` wraps both backend engines and the bridge cross-reference map, providing unified signal routing, label resolution, and observer management.

**Depends on**: Phase 3 (complete) — uses `CompiledCircuitUnified`, `SignalAddress`, `SignalValue`, `BridgeAdapter` from `src/compile/types.ts`.

**Reference**: `spec/unified-component-architecture.md` Section 5 (Simulation Coordinator) and Phase 4 task list (line 1439).

---

## Existing Code to Understand

| File | Purpose |
|------|---------|
| `src/analog/mixed-signal-coordinator.ts` | Bridge-sync logic to fold into new coordinator |
| `src/analog/bridge-instance.ts` | BridgeInstance used by MixedSignalCoordinator |
| `src/compile/types.ts` | `CompiledCircuitUnified`, `SignalAddress`, `SignalValue`, `BridgeAdapter` |
| `src/compile/compile.ts` | `compileUnified()` — produces `CompiledCircuitUnified` |
| `src/core/engine-interface.ts` | `Engine`, `SimulationEngine`, `MeasurementObserver` interfaces |
| `src/core/analog-engine-interface.ts` | `AnalogEngine` interface |
| `src/headless/default-facade.ts` | `DefaultSimulatorFacade` — current consumer, holds `_engine`, `_compiled`, `_compiledAnalog` separately |
| `src/headless/runner.ts` | `SimulationRunner` — current consumer, uses `EngineRecord` discriminated union |
| `src/analog/analog-engine.ts` | `MNAEngine` — concrete analog engine |
| `src/engine/digital-engine.ts` | `DigitalEngine` — concrete digital engine |
| `src/analog/__tests__/mixed-signal-coordinator.test.ts` | Existing coordinator tests to preserve/adapt |
| `src/analog/__tests__/bridge-integration.test.ts` | Bridge integration tests |

---

## Wave 4.1 — Coordinator Interface + Core Implementation

### P4-1: Define SimulationCoordinator interface (S)

**File**: `src/compile/coordinator-types.ts` (new)

Define the `SimulationCoordinator` interface per spec Section 5:

```typescript
interface SimulationCoordinator {
  /** Advance one full step across all active solver backends. */
  step(): void;

  /** Start continuous simulation across all backends. */
  start(): void;

  /** Stop all backends. */
  stop(): void;

  /** Reset all backends to initial state. */
  reset(): void;

  /** Dispose all backends and release resources. */
  dispose(): void;

  /** Read a signal by address (polymorphic across domains). */
  readSignal(addr: SignalAddress): SignalValue;

  /** Write an input signal by address. */
  writeSignal(addr: SignalAddress, value: SignalValue): void;

  /** Read a signal by component label. */
  readByLabel(label: string): SignalValue;

  /** Write an input signal by component label. */
  writeByLabel(label: string, value: SignalValue): void;

  /** Read all labeled signals. Returns Map<label, SignalValue>. */
  readAllSignals(): Map<string, SignalValue>;

  /** Access the digital backend. Null if no digital domain. */
  readonly digitalBackend: SimulationEngine | null;

  /** Access the analog backend. Null if no analog domain. */
  readonly analogBackend: AnalogEngine | null;

  /** The unified compiled output this coordinator was built from. */
  readonly compiled: CompiledCircuitUnified;

  /** Register a measurement observer (notified after each step). */
  addMeasurementObserver(observer: MeasurementObserver): void;

  /** Remove a measurement observer. */
  removeMeasurementObserver(observer: MeasurementObserver): void;
}
```

Also re-export from `src/compile/index.ts`.

**Acceptance**: Types compile with no errors. No runtime behaviour.

---

### P4-2: Write DefaultSimulationCoordinator (L)

**File**: `src/compile/coordinator.ts` (new)

Implement `DefaultSimulationCoordinator` that:

1. **Constructor** accepts `CompiledCircuitUnified` and optional `TransistorModelRegistry`. Creates and initialises backend engines:
   - If `compiled.digital` is non-null → create `DigitalEngine("level")`, call `init(compiled.digital)`.
   - If `compiled.analog` is non-null → create `MNAEngine()`, call `init(compiled.analog)`.
   - Store `compiled.bridges` (the `BridgeAdapter[]`) for bridge sync.
   - Run DC operating point on the analog engine if present.

2. **`step()`** — the unified stepping logic:
   - If only digital: `digitalBackend.step()`.
   - If only analog: `analogBackend.step()`.
   - If both: fold the `MixedSignalCoordinator` bridge-sync logic:
     a. Read analog voltages at bridge input adapters → threshold → digital bits.
     b. Feed bits to digital backend, step it.
     c. Read digital outputs → update bridge output adapters (stamp voltages on analog nodes).
     d. Step analog backend.
   - After stepping, notify all `MeasurementObserver`s via `onStep()`.
   - **Degenerate cases**: When only one backend exists, bridge sync is a no-op (no separate code paths in callers).

3. **`start()` / `stop()`**: delegate to whichever backends exist.

4. **`reset()`**: reset both backends, reset bridge state, notify observers via `onReset()`.

5. **`dispose()`**: dispose both backends, clear observers.

6. **`readSignal(addr)`**: dispatch on `addr.domain`:
   - `"digital"` → `digitalBackend!.getSignalRaw(addr.netId)` → wrap as `{ type: "digital", value }`.
   - `"analog"` → `analogBackend!.getNodeVoltage(addr.nodeId)` → wrap as `{ type: "analog", voltage }`.

7. **`writeSignal(addr, value)`**: dispatch on `addr.domain`:
   - `"digital"` → `digitalBackend!.setSignalValue(addr.netId, BitVector.fromNumber(value.value, addr.bitWidth))`.
   - `"analog"` → throw FacadeError (not yet supported, same as current runner).

8. **`readByLabel(label)` / `writeByLabel(label)`**: look up `compiled.labelSignalMap.get(label)` → delegate to `readSignal`/`writeSignal`.

9. **`readAllSignals()`**: iterate `compiled.labelSignalMap`, call `readSignal` for each → return `Map<string, SignalValue>`.

10. **`addMeasurementObserver` / `removeMeasurementObserver`**: maintain a `Set<MeasurementObserver>`. After each `step()`, call `observer.onStep(stepCount)`. On `reset()`, call `observer.onReset()`.

**Bridge sync detail**: The current `MixedSignalCoordinator` uses `BridgeInstance` with `inputAdapters`/`outputAdapters`. The new coordinator uses `BridgeAdapter[]` from `CompiledCircuitUnified`. The bridge adapter has `digitalNetId`, `analogNodeId`, `direction`, and `electricalSpec`. The threshold logic (V_IL, V_IH) comes from `electricalSpec`. Implement threshold detection inline in the coordinator (read analog voltage → compare to thresholds → produce digital bit, and reverse: read digital bit → produce voltage level).

**Important**: If `compiled.bridges` is empty (no cross-domain boundaries), skip all bridge sync even if both backends exist (they are independent domains).

**Acceptance**: Unit tests pass (P4-3). Coordinator can be constructed from `compileUnified()` output and stepped.

---

### P4-3: Write unit tests for DefaultSimulationCoordinator (M)

**File**: `src/compile/__tests__/coordinator.test.ts` (new)

Test cases:

1. **Digital-only circuit**: Construct coordinator from a compiled AND gate circuit. Verify `digitalBackend` is non-null, `analogBackend` is null. Step and verify signal propagation via `readByLabel()`.

2. **Analog-only circuit**: Construct coordinator from a compiled resistor divider. Verify `analogBackend` is non-null, `digitalBackend` is null. Step and verify voltage via `readByLabel()`.

3. **Signal access by address**: Use `readSignal()` with digital and analog addresses. Verify correct `SignalValue` type returned.

4. **Label-based I/O**: Use `writeByLabel()` to drive an input, step, `readByLabel()` to read output. Verify end-to-end.

5. **readAllSignals()**: Verify returns all labeled signals with correct types.

6. **MeasurementObserver**: Register observer, step, verify `onStep()` called. Reset, verify `onReset()` called.

7. **Degenerate case**: Digital-only coordinator — `step()` works without bridge sync overhead.

8. **start/stop/reset/dispose lifecycle**: Verify state transitions work correctly.

**Acceptance**: All tests pass. Coverage of all public methods.

---

## Wave 4.2 — Integration with Facade and Runner

### P4-4: Update DefaultSimulatorFacade to use SimulationCoordinator (M)

**File**: `src/headless/default-facade.ts` (modify)

Changes:
1. Replace `_engine`, `_compiled`, `_compiledAnalog`, `_dcOpResult` with:
   - `_coordinator: DefaultSimulationCoordinator | null = null`
   - Keep `_clockManager` (still needed for clock advancement in digital mode).

2. `compile(circuit)`:
   - Call `compileUnified(circuit, registry, transistorModels)` once.
   - Create `DefaultSimulationCoordinator(unified)`.
   - Extract `_clockManager` from `unified.digital` if present.
   - Store `_coordinator`.
   - Return `_coordinator` (but the facade interface currently returns `SimulationEngine` — for backward compatibility in this phase, return the digital or analog backend engine. Phase 5 will change the return type).

3. `step(engine, opts)`: Use `_coordinator` for clock advancement. The engine.step() call remains for backward compat.

4. `setInput` / `readOutput` / `readAllSignals`: Delegate to `_coordinator.readByLabel()` / `_coordinator.writeByLabel()` / `_coordinator.readAllSignals()` internally, converting `SignalValue` to raw numbers for the current API contract.

5. `getCompiled()` / `getCompiledAnalog()` / `getDcOpResult()`: Derive from `_coordinator.compiled` and `_coordinator.analogBackend`.

6. `_disposeCurrentEngine()`: Call `_coordinator.dispose()`.

**Important constraint**: The facade's public API signatures (returning `SimulationEngine`, accepting raw numbers) must NOT change in Phase 4. Phase 5 will update these. Phase 4 only changes the internal plumbing.

**Acceptance**: All existing facade tests pass. No API signature changes.

---

### P4-5: Update SimulationRunner to use SimulationCoordinator (M)

**File**: `src/headless/runner.ts` (modify)

Changes:
1. Replace `EngineRecord` discriminated union with a record that holds a `SimulationCoordinator`:
   ```typescript
   interface RunnerRecord {
     coordinator: SimulationCoordinator;
   }
   ```

2. `compile(circuit)`:
   - Create `DefaultSimulationCoordinator` from `compileUnified()` output.
   - Store in WeakMap keyed by the returned engine (for backward compat, return `coordinator.digitalBackend ?? coordinator.analogBackend` cast to `SimulationEngine`).
   - Phase 5 will change the return type to `SimulationCoordinator`.

3. `setInput` / `readOutput` / `readAllSignals`: Delegate to coordinator's label-based methods, converting `SignalValue` to raw numbers.

**Important constraint**: Same as P4-4 — public API signatures must NOT change in Phase 4.

**Acceptance**: All existing runner tests pass. No API signature changes.

---

## Wave 4.3 — Cleanup + Verification

### P4-6: Remove MixedSignalCoordinator as separate class (M)

**Files**:
- Delete `src/analog/mixed-signal-coordinator.ts`
- Update `src/analog/__tests__/mixed-signal-coordinator.test.ts` — either delete if fully superseded by P4-3 coordinator tests, or adapt to test through `DefaultSimulationCoordinator`
- Remove any remaining imports of `MixedSignalCoordinator` from `src/analog/analog-engine.ts`, `src/analog/compiled-analog-circuit.ts`, `src/analog/bridge-adapter.ts`, `src/analog/bridge-instance.ts`
- Grep for all `MixedSignalCoordinator` references in `src/` and remove/update

**Prerequisites**: P4-4 and P4-5 must be complete (all consumers migrated).

**Acceptance**: Zero `MixedSignalCoordinator` references in `src/` (spec files excluded). All tests pass.

---

### P4-7: Full test suite verification (S)

Run `npm test` and verify:
- All tests pass (minus pre-existing submodule failures).
- No regressions from baseline (7486/7490 from Phase 3 end).
- Grep verification: zero `MixedSignalCoordinator` references in `src/`.

**Acceptance**: Test count >= 7486 passing. Zero new failures.
