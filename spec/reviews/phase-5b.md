# Review Report: Phase 5b — Eliminate Whole-Circuit Domain Branching

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 31 (P5b-1 through P5b-30 + P5b-getengine-cleanup) |
| Violations | 8 |
| Gaps | 2 |
| Weak tests | 2 |
| Legacy references | 6 |
| **Verdict** | **has-violations** |

---

## Violations

### V-1 — Historical-provenance comment in `src/headless/facade.ts`

- **File**: `src/headless/facade.ts`
- **Lines**: 99, 107, 116, 126, 137, 148
- **Rule violated**: No historical-provenance comments (rules.md). Comments describing what code replaced or used to do are banned.
- **Evidence** (repeated 6 times):

      * @param coordinator - The compiled coordinator (or legacy SimulationEngine)

  These JSDoc strings name the old API surface (`SimulationEngine`) that the phase was supposed to eliminate. They are historical-provenance comments in the interface file, signalling the interface has not been fully cleaned up.
- **Severity**: minor

---

### V-2 — Unnecessary `as unknown as` cast in `disposeViewers()` — `src/app/app-init.ts`

- **File**: `src/app/app-init.ts`
- **Lines**: 2070, 2080
- **Rule violated**: No backwards-compatibility shims or safety wrappers (rules.md). `SimulationCoordinator` explicitly declares `removeMeasurementObserver()` at coordinator-types.ts line 93. Casting `eng` to a structural duck type is a shim that works around a type the agent already knows.
- **Evidence**:

      (eng as unknown as { removeMeasurementObserver(o: unknown): void } | null)?.removeMeasurementObserver(activeTimingPanel);

  `facade.getCoordinator()` returns `DefaultSimulationCoordinator | null`, which implements `SimulationCoordinator`. The correct call is `eng?.removeMeasurementObserver(activeTimingPanel)` with no cast.
- **Severity**: major

---

### V-3 — Duck-type shim in `DefaultSimulatorFacade.step()` and `runToStable()` — `src/headless/default-facade.ts`

- **File**: `src/headless/default-facade.ts`
- **Lines**: 127, 143
- **Rule violated**: No backwards-compatibility shims (rules.md). Spec §2.4 and §2.5 define clean coordinator-only implementations. The duck-type guards are compatibility fallbacks for the old `SimulationEngine` path.
- **Evidence**:

      // line 127
      if (advance && 'advanceClocks' in coordinator) {
        (coordinator as SimulationCoordinator).advanceClocks();
      }
      // line 143
      const coord: SimulationCoordinator | null =
        'snapshotSignals' in engineOrCoord
          ? (engineOrCoord as SimulationCoordinator)
          : this._coordinator;

  Spec §2.4 specifies the simplified signature as `step(coordinator: SimulationCoordinator, opts?: StepOptions): void` with no duck-type guard.
- **Severity**: major

---

### V-4 — Duck-type check for `SimulationEngine` path in `runTests()` — `src/headless/default-facade.ts`

- **File**: `src/headless/default-facade.ts`
- **Lines**: 254–255
- **Rule violated**: No backwards-compatibility shims (rules.md). Spec §2 removes all `SimulationEngine` reach-throughs from the facade.
- **Evidence**:

      } else if ('getSignalRaw' in engineOrCoord) {
        digitalEngine = engineOrCoord as SimulationEngine;
      }

  An explicit `SimulationEngine` fallback path surviving in `runTests()` is a shim.
- **Severity**: major

---

### V-5 — `WatchedSignal` retains `netId: number` instead of `addr: SignalAddress` — `src/app/app-init.ts`

- **File**: `src/app/app-init.ts`
- **Lines**: 2050–2056
- **Rule violated**: No backwards-compatibility shims (rules.md). Spec §3.9 requires uniform use of `wireSignalMap`/`labelSignalMap` with `SignalAddress`. The P5b-12 completion note (progress.md line 849) claims `addr` was added to `WatchedSignal`, but the file shows it was not.
- **Evidence**:

      interface WatchedSignal {
        name: string;
        netId: number;   // raw integer — not SignalAddress
        width: number;
        group: SignalGroup;
        panelIndex: number;
      }

  In `rebuildViewers()` (lines 2126–2128) the analog path reconstructs `SignalAddress` inline from `netId`:

      panel.addVoltageChannel(
        { domain: 'analog' as const, nodeId: s.netId },
        s.name,
      );

- **Severity**: major

---

### V-6 — `rebuildViewers()` branches on `isAnalog` whole-circuit mode to select panel type — `src/app/app-init.ts`

- **File**: `src/app/app-init.ts`
- **Lines**: 2103, 2106, 2154
- **Rule violated**: Spec §7 acceptance criteria: Zero `isAnalogMode()` or equivalent whole-circuit mode check in consumer code. `const isAnalog = coordinator.timingModel !== 'discrete'` used to fork between `AnalogScopePanel` and `TimingDiagramPanel` construction is functionally equivalent to the banned `isAnalogMode()`.
- **Evidence**:

      const isAnalog = coordinator.timingModel !== 'discrete';
      if (viewerTimingContainer) {
        if (isAnalog) {
          // create AnalogScopePanel per group
        } else {
          // create TimingDiagramPanel
        }
      }

  Note: `timingModel !== 'discrete'` in `startSimulation()` (line 1834) and the render tick (line 1879) is explicitly permitted by spec §3.2–§3.3. The violation is the structural panel-type branching in `rebuildViewers()`.
- **Severity**: major

---

### V-7 — `computeFrameSteps` discrete path returns `steps: 0` with no floor — `src/solver/coordinator.ts`

- **File**: `src/solver/coordinator.ts`
- **Line**: 607
- **Rule violated**: Completeness (rules.md). At the minimum spec-defined speed of 1 step/s with a 16ms frame (wallDt=0.016), `Math.round(1 * 0.016) = 0`, causing zero simulation steps that frame.
- **Evidence**:

      steps: Math.round(this._speedControl.speed * clampedDt),

  No `Math.max(1, ...)` floor applied. The render loop (`for (let i = 0; i < frame.steps; i++)`) executes zero iterations at low speeds. The speed control tests confirm MIN_SPEED = 1, making this scenario reachable.
- **Severity**: minor

---

### V-8 — Historical-provenance comment in `src/io/dts-schema.ts`

- **File**: `src/io/dts-schema.ts`
- **Line**: 152
- **Rule violated**: No historical-provenance comments (rules.md). Not a Phase 5b modified file; included for completeness per reviewer mandate.
- **Evidence**:

      // Normalize legacy 'digb' format tag to 'dts' in the returned document.

- **Severity**: minor

---

## Gaps

### G-1 — `WatchedSignal.addr: SignalAddress` never added — spec §3.9 requirement incomplete

- **Spec requirement**: P5b-27 (§3.9) requires `rebuildViewers()` to use `wireSignalMap`/`SignalAddress` uniformly. P5b-12 progress note (progress.md lines 791–796) listed adding `addr: SignalAddress` to `WatchedSignal` as remaining work; the completion note (line 849) claims it was resolved.
- **What was found**: `WatchedSignal` has only `netId: number`. The `addr` field is absent. `rebuildViewers()` reconstructs `SignalAddress` inline from raw `netId` using domain branching.
- **File**: `src/app/app-init.ts` lines 2050–2056, 2126, 2154

---

### G-2 — `DefaultSimulatorFacade` method signatures not narrowed to `SimulationCoordinator` — spec §2 requirement not met

- **Spec requirement**: §2.4 specifies `step(coordinator: SimulationCoordinator, opts?: StepOptions): void` with no `SimulationEngine` union. §2 generally removes all `SimulationEngine` pass-throughs from the facade.
- **What was found**: `step`, `run`, `runToStable`, `setInput`, `readOutput`, `readAllSignals`, and `runTests` in `default-facade.ts` all retain `SimulationCoordinator | SimulationEngine` union parameter types. The `SimulatorFacade` interface (`facade.ts`) still declares these union types with `legacy SimulationEngine` JSDoc on every method.
- **File**: `src/headless/default-facade.ts` lines 125, 133, 139; `src/headless/facade.ts` lines 99–148

---

## Weak Tests

### WT-1 — `signalCount` test uses `toBeGreaterThan(0)` — insufficient assertion

- **Test path**: `src/solver/__tests__/coordinator-capability.test.ts::snapshotSignals and signalCount — digital-only coordinator::signalCount equals digital netCount`
- **What is wrong**: `expect(coordinator.signalCount).toBeGreaterThan(0)` verifies only that the value is non-zero. The spec says `signalCount` must equal the digital netCount. An implementation returning 1 passes this test regardless of the actual netCount of the AND-gate circuit (which has more than 1 net).
- **Evidence**:

      expect(coordinator.signalCount).toBeGreaterThan(0);

---

### WT-2 — `computeFrameSteps` continuous test accesses private `_analog` field

- **Test path**: `src/solver/__tests__/coordinator-speed-control.test.ts::DefaultSimulationCoordinator -- computeFrameSteps (continuous)::simTimeGoal equals simTime plus speed times wallDt`
- **What is wrong**: The test reads `(coord as any)._analog.simTime` — a private implementation detail. The public `coordinator.simTime` property exists and should be used instead.
- **Evidence**:

      const simTimeBefore = (coord as any)._analog.simTime as number;

---

## Legacy References

### LR-1 — `src/headless/facade.ts` lines 99, 107, 116, 126, 137, 148

Six occurrences of `* @param coordinator - The compiled coordinator (or legacy SimulationEngine)` in the `SimulatorFacade` interface JSDoc. Name-checks the superseded `SimulationEngine` API as a still-valid alternative.

---

### LR-2 — `src/headless/default-facade.ts` line 127

    if (advance && 'advanceClocks' in coordinator) {

Duck-type guard referencing the old `SimulationEngine` path that does not have `advanceClocks`.

---

### LR-3 — `src/headless/default-facade.ts` line 143

    'snapshotSignals' in engineOrCoord

Duck-type guard for the old `SimulationEngine` fallback path.

---

### LR-4 — `src/headless/default-facade.ts` line 254

    } else if ('getSignalRaw' in engineOrCoord) {
      digitalEngine = engineOrCoord as SimulationEngine;
    }

Explicit reference to `getSignalRaw`, a `SimulationEngine`-specific method, used as a shim fallback in `runTests()`.

---

### LR-5 — `src/app/app-init.ts` line 3149

    // JSON — distinguish .dts format from legacy .digj

Historical-provenance comment in a Phase 5b modified file naming the superseded format `digj`.

---

### LR-6 — `src/io/dts-schema.ts` line 152

    // Normalize legacy 'digb' format tag to 'dts' in the returned document.

Historical-provenance comment. File is not Phase 5b modified; included for completeness.

---

## Grep Acceptance Check Results (§7)

All six spec §7 grep checks return zero hits. The structural grep acceptance criteria are met.

| Check | Result |
|-------|--------|
| `analogBackend` or `digitalBackend` in consumer code | 0 hits |
| `isAnalogMode` or `_engineMode` | 0 hits |
| `getCompiledAnalog` or `getCompiled()` in consumers | 0 hits |
| `compiled.analog` or `compiled.digital` in consumers | 0 hits |
| `engine.getSignalRaw` or `engine.getNodeVoltage` in consumers | 0 hits |
| `AnalogEngine` in runtime/editor/app files | 0 hits |

The `isAnalog` local variable in `rebuildViewers()` escapes the `isAnalogMode` grep pattern (see V-6 above). The grep check passes at the pattern level but the semantic violation remains.