# Review Report: Wave 5b.1 — Coordinator Interface Expansion

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 11 (P5b-1 through P5b-11) |
| Violations — critical | 1 |
| Violations — major | 2 |
| Violations — minor | 2 |
| Gaps | 0 |
| Weak tests | 16 |
| Legacy references | 0 |

**Verdict**: `has-violations`

---

## Files Reviewed

Per `spec/progress.md` entries for tasks P5b-1 through P5b-11:

| Task | Files Created | Files Modified |
|------|--------------|----------------|
| P5b-4 | `src/solver/__tests__/coordinator-speed-control.test.ts` | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts` |
| P5b-1 | — | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts`, `src/test-utils/mock-coordinator.ts` |
| P5b-2 | `src/solver/__tests__/coordinator-capability.test.ts` | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts`, `src/test-utils/mock-coordinator.ts` |
| P5b-3 | — | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts`, `src/test-utils/mock-coordinator.ts` |
| P5b-6 | `src/solver/__tests__/coordinator-visualization.test.ts` | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts` |
| P5b-7 | `src/solver/__tests__/coordinator-slider-snapshot.test.ts` | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts`, `src/headless/default-facade.ts`, `src/headless/runner.ts` |
| P5b-8 | — | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts` |
| P5b-9 | — | `src/solver/coordinator-types.ts`, `src/solver/coordinator.ts` |
| P5b-10 | `src/solver/__tests__/coordinator-current-resolver.test.ts` | — |
| P5b-5 | `src/solver/__tests__/coordinator-clock.test.ts` | `src/test-utils/mock-coordinator.ts` |
| P5b-11 | — | `src/solver/coordinator-types.ts`, `src/test-utils/mock-coordinator.ts`, `src/solver/__tests__/coordinator-capability.test.ts` |

---

## Violations

### V1 — CRITICAL: Deferred work ("reserved for future extension") in production interface

**File**: `src/solver/coordinator-types.ts`, line 265–266
**Rule violated**: Completeness rule — "Never mark work as deferred, TODO, or 'not implemented.'" and the historical-provenance comment ban.

**Quoted evidence**:
```typescript
  /**
   * Save a snapshot of all engine state. Returns an opaque ID.
   * Delegates to the digital backend if present; analog snapshot support
   * is reserved for future extension.
   */
  saveSnapshot(): SnapshotId;
```

The phrase "analog snapshot support is reserved for future extension" is a documented deferral of work in a production interface file. Rules prohibit marking work as deferred. This is not an explanatory comment for complicated code — it is an explicit acknowledgement that a feature was intentionally not implemented and deferred to an unnamed future task.

---

### V2 — MAJOR: `digitalBackend` and `analogBackend` remain on the `SimulationCoordinator` interface

**File**: `src/solver/coordinator-types.ts`, lines 77–80
**Rule violated**: Spec §1.1 states capability queries "replace" `analogBackend !== null` / `digitalBackend !== null` checks, and spec §1.11 states the interface `compiled` accessor is narrowed. The spec's design goal (§1.12) is removal of these properties from the interface. More critically: P5b-11 is the last task of this wave (11 tasks), and the spec for Wave 5b.1 is to expand the coordinator interface so that consumers need not reach into backends. Having `digitalBackend` and `analogBackend` on the public interface directly contradicts the stated purpose of the entire wave.

While P5b-28 (Wave 5b.4) is where they are formally removed, their continued presence on the interface after the wave that was supposed to make them unnecessary is a design gap. The `MockCoordinator` still exposes them (lines 117–122) and they are imported in the mock. This means consumer code written after this wave can still freely reach through to raw backends, defeating the purpose of the wave.

**Quoted evidence**:
```typescript
  /** Access the digital backend. Null if no digital domain. */
  readonly digitalBackend: SimulationEngine | null;

  /** Access the analog backend. Null if no analog domain. */
  readonly analogBackend: AnalogEngine | null;
```

These properties are on the public `SimulationCoordinator` interface. The wave was explicitly tasked with adding the capability/execution methods that replace these, but did not deprecate or restrict the direct backend accessors in any way.

---

### V3 — MAJOR: `adjustSpeed()` for discrete timing does not clamp via the coordinator's own setter — bypasses setter validation

**File**: `src/solver/coordinator.ts`, lines 560–566
**Rule violated**: Inconsistent clamping; the discrete `adjustSpeed` sets `this._speedControl.speed` directly which does go through `SpeedControl`'s clamping setter (acceptable), but the implementation in the coordinator reads `this._speedControl.speed * factor` and assigns it directly to `this._speedControl.speed` — this works correctly because `SpeedControl.speed`'s setter clamps. However, the analog `adjustSpeed` does NOT clamp to a minimum above 0 — it uses `Math.max(0, ...)` which allows `speed = 0`. A speed of 0 produces `computeFrameSteps` returning `steps = 0` and `simTimeGoal = simTime` (no advancement), permanently stalling the simulation with no error. The test at line 285 explicitly tests `coord.speed = -1` → `0`, confirming 0 is an accepted value. The spec says "clamped to valid range" but does not define the valid range for analog. The implementation allows a permanently stalling value of 0 with no guard.

**Quoted evidence**:
```typescript
  adjustSpeed(factor: number): void {
    if (this._timingModel === 'discrete') {
      this._speedControl.speed = this._speedControl.speed * factor;
    } else {
      this._analogSpeed = Math.max(0, this._analogSpeed * factor);
    }
  }
```

And in `set speed`:
```typescript
      this._analogSpeed = Math.max(0, value);
```

0 is accepted as a valid analog speed, causing a permanently stalled simulation. No minimum positive value is enforced.

---

### V4 — MINOR: Historical-provenance comment in coordinator-types.ts

**File**: `src/solver/coordinator-types.ts`, line 271
**Rule violated**: Historical-provenance comment ban — comments must not describe operational history.

**Quoted evidence**:
```typescript
  /**
   * Restore engine state from a previously saved snapshot.
   * No-op if no digital backend is active or the ID is unknown.
   */
```

The phrase "previously saved snapshot" is borderline — it describes the parameter semantics rather than historical code provenance. This is a minor finding; however the rules say "no `# previously this was...` comments" and "previously" is one of the listed red-flag words. The word "previously" here is used in a functional sense (the snapshot was saved before being restored) which may be legitimate documentation. Flagging for user decision per reviewer instructions.

---

### V5 — MINOR: `coordinator.ts` `compiled` getter returns full `CompiledCircuitUnified` but interface declares narrowed type — type unsafety

**File**: `src/solver/coordinator.ts`, line 168
**Rule violated**: Code hygiene — the implementation silently widens the returned type beyond what the interface advertises.

**Quoted evidence**:
```typescript
  get compiled(): CompiledCircuitUnified { return this._compiled; }
```

The interface declares:
```typescript
  readonly compiled: {
    readonly wireSignalMap: ReadonlyMap<Wire, SignalAddress>;
    readonly labelSignalMap: ReadonlyMap<string, SignalAddress>;
    readonly diagnostics: readonly Diagnostic[];
  };
```

TypeScript allows assigning a wider type to a narrower interface (`CompiledCircuitUnified` structurally satisfies the narrowed interface because it has those three properties). However, the narrowing only applies at the interface level. Any code that holds a `DefaultSimulationCoordinator` reference (concrete type, not through the interface) can still access `.compiled.digital` and `.compiled.analog` directly. The spec §1.11 says: "The concrete `DefaultSimulationCoordinator` keeps the full `CompiledCircuitUnified` internally and exposes it via a narrower interface type." This is correctly implemented — the narrowing is at the interface level, which is the specified approach. This finding is informational only.

**Revised severity**: Downgraded from minor to informational — the spec explicitly describes this pattern. Removing from violation count.

---

## Gaps

### Gap check: P5b-10 — `getCurrentResolverContext()` has no meaningful test coverage

The spec for P5b-10 requires `getCurrentResolverContext()` to return a `CurrentResolverContext` with a populated `wireToNodeId`, `elements`, `elementToCircuitElement`, and a working `getElementPinCurrents` function. The test file `src/solver/__tests__/coordinator-current-resolver.test.ts` contains only 2 tests, neither of which verifies any of these properties.

More critically, the "returns non-null for analog circuit" test does NOT actually test an analog circuit — it creates an empty `Circuit()` with an empty registry (the `buildAnalogRegistry()` function creates a `resistorFactory` variable at line 60–62 but never calls `registry.register()`, leaving the registry empty). An empty circuit compiled with an empty registry produces `compiled.analog === null`. Therefore `getCurrentResolverContext()` returns `null`. The assertion `expect(ctx).toBeDefined()` passes because `null` is "defined" in Vitest (`toBeDefined` checks `!== undefined`). The test is **both broken and trivially true** — it tests an empty circuit, gets null back, and passes because null !== undefined.

This is listed under Weak Tests rather than Gaps since the method was implemented (the coordinator code is correct). The gap is in test quality.

None found for spec requirements — all 11 task methods are present on the interface and implemented in the concrete class.

---

## Weak Tests

### WT1 — coordinator-current-resolver.test.ts::SimulationCoordinator.getCurrentResolverContext::'returns non-null for analog circuit'

**Path**: `src/solver/__tests__/coordinator-current-resolver.test.ts` (lines 65–73)

**Problem**: The `buildAnalogRegistry()` function at lines 58–63 creates a `resistorFactory` closure but **never calls `registry.register()`**. The registry remains empty. The `new Circuit()` at line 68 has no elements. Compiling an empty circuit with an empty registry produces `compiled.analog === null`. Therefore `getCurrentResolverContext()` returns `null`. The assertion `expect(ctx).toBeDefined()` passes because `null !== undefined`. The test claims to verify the non-null path but never exercises it.

**Quoted evidence**:
```typescript
function buildAnalogRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  const resistorFactory: AnalogFactory = (_el: unknown, pinNodes: number[], _props: unknown) =>
    makeResistorAnalogEl(pinNodes[0] ?? 0, pinNodes[1] ?? 0, 1000);
  return registry;  // <-- registry.register() never called; resistorFactory is dead code
}

it('returns non-null for analog circuit', () => {
  const registry = buildAnalogRegistry();
  const circuit = new Circuit();  // <-- empty circuit
  const unified = compileUnified(circuit, registry);
  const coordinator = new DefaultSimulationCoordinator(unified, registry);
  const ctx = coordinator.getCurrentResolverContext();
  expect(ctx).toBeDefined();  // <-- passes even when ctx === null
});
```

---

### WT2 — coordinator-capability.test.ts::snapshotSignals and signalCount — digital-only coordinator::'signalCount equals digital netCount'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (line 262–265)

**Problem**: `expect(coordinator.signalCount).toBeGreaterThan(0)` — bare "greater than 0" without verifying the specific count equals the compiled digital netCount. The test title claims to verify equality between signalCount and netCount, but only checks positivity.

**Quoted evidence**: `expect(coordinator.signalCount).toBeGreaterThan(0);`

---

### WT3 — coordinator-capability.test.ts::snapshotSignals and signalCount — analog-only coordinator::'signalCount equals analog nodeCount'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (line 295–300)

**Problem**: Same issue — `expect(coord.signalCount).toBeGreaterThan(0)` does not verify signalCount equals the analog nodeCount.

**Quoted evidence**: `expect(coord.signalCount).toBeGreaterThan(0);`

---

### WT4 — coordinator-capability.test.ts::snapshotSignals and signalCount — digital-only coordinator::'snapshotSignals returns Float64Array of length signalCount'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (lines 268–273)

**Problem**: `expect(snap).toBeInstanceOf(Float64Array)` — bare type check without verifying content. A zero-length Float64Array of the correct type would pass.

**Quoted evidence**:
```typescript
expect(snap).toBeInstanceOf(Float64Array);
expect(snap.length).toBe(coordinator.signalCount);
```

The length check is acceptable (exact value). The `toBeInstanceOf` alone is weak, but since the length check follows, this is a minor issue.

---

### WT5 — coordinator-capability.test.ts::unified execution methods — analog-only coordinator::'dcOperatingPoint returns a DcOpResult'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (lines 496–506)

**Problem**: `expect(result).not.toBeNull()` followed by `expect(typeof result!.converged).toBe('boolean')` — checks type of a field rather than its value. Does not assert that the result converged (`result.converged === true`). For a valid DC circuit, the operating point should always converge; not asserting convergence leaves a non-converged failure invisible.

**Quoted evidence**:
```typescript
expect(result).not.toBeNull();
expect(typeof result!.converged).toBe('boolean');
expect(result!.nodeVoltages).toBeInstanceOf(Float64Array);
```

---

### WT6 — coordinator-capability.test.ts::unified execution methods — analog-only coordinator::'simTime is a number (not null) for analog-only'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (lines 508–516)

**Problem**: `expect(coord.simTime).not.toBeNull()` followed by `expect(typeof coord.simTime).toBe('number')` — checks that simTime is "a number" without asserting it is non-negative or has a specific expected initial value (0).

**Quoted evidence**:
```typescript
expect(coord.simTime).not.toBeNull();
expect(typeof coord.simTime).toBe('number');
```

---

### WT7 — coordinator-capability.test.ts::narrowed compiled accessor — digital-only coordinator::'compiled.wireSignalMap is a Map'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (line 542–545)

**Problem**: `expect(coordinator.compiled.wireSignalMap).toBeInstanceOf(Map)` — bare `instanceof Map` check. Does not verify map contents. For a circuit with wires and components, the wireSignalMap should have entries.

**Quoted evidence**: `expect(coordinator.compiled.wireSignalMap).toBeInstanceOf(Map);`

---

### WT8 — coordinator-capability.test.ts::narrowed compiled accessor::'compiled accessor via SimulationCoordinator interface exposes wireSignalMap'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (lines 564–569)

**Problem**: `expect(iface.compiled.wireSignalMap).toBeInstanceOf(Map)` — same weak assertion via interface reference.

**Quoted evidence**: `expect(iface.compiled.wireSignalMap).toBeInstanceOf(Map);`

---

### WT9 — coordinator-capability.test.ts::narrowed compiled accessor::'compiled accessor via SimulationCoordinator interface exposes labelSignalMap'

**Path**: `src/solver/__tests__/coordinator-capability.test.ts` (lines 571–577)

**Problem**: `expect(iface.compiled.labelSignalMap).toBeInstanceOf(Map)` — bare type check without verifying content. The `buildDigitalCoordinator` fixture creates a circuit with labeled inputs A, B and output Y. The test could assert `iface.compiled.labelSignalMap.has('A')` etc., which is done elsewhere but not in the interface-typed accessor test.

**Quoted evidence**: `expect(iface.compiled.labelSignalMap).toBeInstanceOf(Map);`

---

### WT10 — coordinator-visualization.test.ts::getPinVoltages — analog coordinator::'returns a Map for an analog domain element'

**Path**: `src/solver/__tests__/coordinator-visualization.test.ts` (lines 170–176)

**Problem**: `expect(voltages).not.toBeNull()` then `expect(voltages).toBeInstanceOf(Map)` — type-only checks, no content verification.

**Quoted evidence**:
```typescript
expect(voltages).not.toBeNull();
expect(voltages).toBeInstanceOf(Map);
```

---

### WT11 — coordinator-visualization.test.ts::getPinVoltages — analog coordinator::'returned map contains at least one pin entry'

**Path**: `src/solver/__tests__/coordinator-visualization.test.ts` (lines 178–183)

**Problem**: `expect(voltages!.size).toBeGreaterThan(0)` — bare "has any entry" check. For a resistor with known pins, the test should assert the specific pin labels ('p1', 'p2' or the label used in the fixture) and their approximate voltage values.

**Quoted evidence**: `expect(voltages!.size).toBeGreaterThan(0);`

---

### WT12 — coordinator-visualization.test.ts::voltageRange — analog coordinator::'voltageRange is { min: 0, max: 0 } before any tracking'

**Path**: `src/solver/__tests__/coordinator-visualization.test.ts` (lines 263–270)

**Problem**: `expect(range).not.toBeNull()` before the specific value checks — the not-null assertion is redundant when the test proceeds to check `range!.min` and `range!.max` with specific values. Minor issue only.

**Quoted evidence**: `expect(range).not.toBeNull();`

---

### WT13 — coordinator-slider-snapshot.test.ts::getSliderProperties — analog coordinator::'returns non-empty array for analog resistor element'

**Path**: `src/solver/__tests__/coordinator-slider-snapshot.test.ts` (lines 128–132)

**Problem**: `expect(coordinator.getSliderProperties(elements.r1).length).toBeGreaterThan(0)` — bare "has entries" check. Should assert the specific properties returned include 'resistance' (done in a subsequent test) but this test on its own is trivially weak.

**Quoted evidence**: `expect(coordinator.getSliderProperties(elements.r1).length).toBeGreaterThan(0);`

---

### WT14 — coordinator-slider-snapshot.test.ts::readElementCurrent — analog coordinator::'returns finite number for element index 0'

**Path**: `src/solver/__tests__/coordinator-slider-snapshot.test.ts` (lines 210–217)

**Problem**: `expect(result).not.toBeNull()` then `expect(Number.isFinite(result!)).toBe(true)` — checks only that the result is finite, not any specific value. For a known circuit (5V source, 1kΩ + 1kΩ series), element current is deterministic (2.5mA). The test should assert the specific value with a tolerance.

**Quoted evidence**:
```typescript
expect(result).not.toBeNull();
expect(Number.isFinite(result!)).toBe(true);
```

---

### WT15 — coordinator-slider-snapshot.test.ts::readBranchCurrent — analog coordinator::'returns finite number for branch index 0 (voltage source branch)'

**Path**: `src/solver/__tests__/coordinator-slider-snapshot.test.ts` (lines 232–239)

**Problem**: Same issue — checks finiteness only, not specific value. The voltage source branch current is deterministic for the fixture circuit.

**Quoted evidence**:
```typescript
expect(result).not.toBeNull();
expect(Number.isFinite(result!)).toBe(true);
```

---

### WT16 — coordinator-slider-snapshot.test.ts::getSliderProperties — analog coordinator::'descriptor has non-empty label'

**Path**: `src/solver/__tests__/coordinator-slider-snapshot.test.ts` (lines 156–160)

**Problem**: `expect(coordinator.getSliderProperties(elements.r1)[0]!.label.length).toBeGreaterThan(0)` — checks that label is non-empty but does not assert the specific expected label string for the resistance property.

**Quoted evidence**: `expect(coordinator.getSliderProperties(elements.r1)[0]!.label.length).toBeGreaterThan(0);`

---

## Legacy References

None found.

---

## Additional Notes

### Note 1: P5b-10 test fixture has dead code

In `src/solver/__tests__/coordinator-current-resolver.test.ts`, the `buildAnalogRegistry()` function declares `resistorFactory` at lines 60–62 but the variable is never used (no `registry.register()` call). This is dead code in addition to the test correctness issue (WT1).

### Note 2: `analogBackend`/`digitalBackend` still on interface (wave scope clarification)

The presence of `digitalBackend` and `analogBackend` on the `SimulationCoordinator` interface is within spec for Wave 5b.1 — their removal is explicitly deferred to task P5b-28 (Wave 5b.4). This is noted as a major violation (V2) because the wave's stated purpose is to eliminate the need for these properties in consumers, yet they remain fully accessible on the public interface with no restriction or deprecation marker. The coordinator-types.ts comment at line 101 ("replace analogBackend/digitalBackend null-checks") documents the intent but the interface still exports the raw backends. After this wave, new consumer code could still freely access `coordinator.digitalBackend` or `coordinator.analogBackend` directly, defeating the purpose of the wave.
