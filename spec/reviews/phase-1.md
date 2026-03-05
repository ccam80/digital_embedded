# Review Report: Phase 1 — Foundation Layer

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 10 (1.1.1, 1.1.2, 1.2.1, 1.2.2, 1.2.3, 1.3.1, 1.3.2, 1.3.3, 1.3.4, 1.3.5) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 4 |
| Gaps | 3 |
| Weak tests | 5 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V-001 — `OscillationError` added to `errors.ts` outside Phase 1 spec scope (major)

**File**: `src/core/errors.ts`, lines 164–191
**Rule violated**: Code Hygiene — "No fallbacks. No backwards compatibility shims. No safety wrappers." / Completeness — agents must not add out-of-scope content.
**Evidence**:
```typescript
// OscillationError — circuit did not stabilize within iteration limit
export class OscillationError extends SimulationError {
  /** Number of iterations attempted before giving up. */
  readonly iterations: number;
  ...
}
```
**Explanation**: The Phase 1 spec for task 1.3.5 defines exactly five error types: `SimulationError`, `BurnException`, `BacktrackException`, `BitsException`, `NodeException`, and `PinException`. `OscillationError` is not in this list. It was added in the `spec/progress.md` entry for task 3.5.1 ("Files modified: src/core/errors.ts (added OscillationError)"), meaning it was retrofitted into a Phase 1 file by a later phase agent. This is scope creep in the Phase 1 file — the file as-delivered in Phase 1 contains an out-of-spec class. The file is now outside Phase 1's specification and the addition was not authorised by the Phase 1 spec.

---

### V-002 — `addMeasurementObserver` / `removeMeasurementObserver` added to `SimulationEngine` outside Phase 1 spec scope (major)

**File**: `src/core/engine-interface.ts`, lines 279–291
**Rule violated**: Scope creep — content not specified in task 1.3.2.
**Evidence**:
```typescript
  /**
   * Register an observer for measurement data collection.
   * Called after each simulation step completes.
   */
  addMeasurementObserver(observer: MeasurementObserver): void;

  /**
   * Remove a previously registered measurement observer.
   */
  removeMeasurementObserver(observer: MeasurementObserver): void;
```
And the `MeasurementObserver` interface at lines 92–97:
```typescript
export interface MeasurementObserver {
  onStep(stepCount: number): void;
  onReset(): void;
}
```
**Explanation**: The Phase 1 spec for task 1.3.2 defines the `SimulationEngine` interface with specific methods: `init`, `reset`, `dispose`, `step`, `microStep`, `runToBreak`, `start`, `stop`, `getState`, `getSignalRaw`, `getSignalValue`, `setSignalValue`, `addChangeListener`, `removeChangeListener`. It also defines `EngineMessage` types for Worker communication. Neither `MeasurementObserver` nor `addMeasurementObserver`/`removeMeasurementObserver` appear in the spec. These are unspecified additions to the interface contract.

---

### V-003 — `SimulationEvent` interface added to `engine-interface.ts` outside Phase 1 spec scope (major)

**File**: `src/core/engine-interface.ts`, lines 62–78
**Rule violated**: Scope creep — content not specified in task 1.3.2.
**Evidence**:
```typescript
export interface SimulationEvent {
  /** Simulation time at which this event fires (nanoseconds). */
  readonly timestamp: bigint;
  /** Net ID whose value changes when this event fires. */
  readonly netId: number;
  /** New value for the net. */
  readonly value: number;
}
```
**Explanation**: `SimulationEvent` is not part of the task 1.3.2 specification. The spec lists `CompiledCircuit`, `EngineState`, `EngineChangeListener`, `SimulationEngine`, and `EngineMessage` as the outputs. `SimulationEvent` is an unspecified addition.

---

### V-004 — `getOrDefault` method added to `PropertyBag` outside spec (minor)

**File**: `src/core/properties.ts`, lines 73–79
**Rule violated**: Scope creep — method not specified in task 1.2.3.
**Evidence**:
```typescript
  getOrDefault<T extends PropertyValue>(key: string, defaultValue: T): T {
    const value = this._map.get(key);
    if (value === undefined) {
      return defaultValue;
    }
    return value as T;
  }
```
**Explanation**: Task 1.2.3 specifies `get<T>`, `set`, `has`, `clone`, and `entries` as the `PropertyBag` API. `getOrDefault` is not in the spec. It has been added without authorisation.

---

### V-005 — `ClockConfig` / `createClockConfig` / `isPinClock` added to `pin.ts` outside spec (minor)

**File**: `src/core/pin.ts`, lines 63–74
**Rule violated**: Scope creep — types not specified in task 1.2.2.
**Evidence**:
```typescript
export interface ClockConfig {
  readonly clockPins: ReadonlySet<string>;
}

export function createClockConfig(clockPinLabels: readonly string[]): ClockConfig {
  return { clockPins: new Set(clockPinLabels) };
}

export function isPinClock(config: ClockConfig, label: string): boolean {
  return config.clockPins.has(label);
}
```
**Explanation**: Task 1.2.2 specifies `PinDirection`, `Pin`, `PinDeclaration`, `InverterConfig`, N/S/E/W layout helpers, and `Point`. The task mentions `isClock` as a field on `Pin` and `isClockCapable` on `PinDeclaration`, but does not specify a separate `ClockConfig` abstraction analogous to `InverterConfig`. This is an unspecified addition. The spec's design only requires `isClock` to be a boolean on `Pin` — the corresponding configuration mechanism was not specified.

---

### V-006 — `standardGatePinLayout` helper added to `pin.ts` outside spec (minor)

**File**: `src/core/pin.ts`, lines 232–261
**Rule violated**: Scope creep — function not specified in task 1.2.2.
**Evidence**:
```typescript
export function standardGatePinLayout(
  inputLabels: readonly string[],
  outputLabel: string,
  componentW: number,
  componentH: number,
  defaultBitWidth: number = 1,
): PinDeclaration[] {
```
**Explanation**: Task 1.2.2 specifies "N/S/E/W layout helpers: functions to compute pin positions for standard component orientations." The `layoutPinsOnFace` function clearly satisfies this. `standardGatePinLayout` is an additional convenience function not specified in the task.

---

### V-007 — `size` getter added to `PropertyBag` outside spec (minor)

**File**: `src/core/properties.ts`, lines 109–111
**Rule violated**: Scope creep — method not specified in task 1.2.3.
**Evidence**:
```typescript
  get size(): number {
    return this._map.size;
  }
```
**Explanation**: Task 1.2.3 specifies `get<T>`, `set`, `has`, `clone`, and `entries` as the `PropertyBag` API. A `size` getter is not in the spec.

---

## Gaps

### G-001 — Task 1.3.2: `EngineState.ERROR` state unreachable / untested via state transitions

**Spec requirement**: Task 1.3.2 specifies `EngineState` enum with values `STOPPED`, `RUNNING`, `PAUSED`, `ERROR`.
**What was found**: `EngineState.ERROR` is defined in the enum (`src/core/engine-interface.ts`, line 46) but `MockEngine` has no mechanism to enter the `ERROR` state and there is no test verifying that the engine can transition to `ERROR`. The engine test at `src/core/__tests__/engine-interface.test.ts` line 69 describes "transitions through all four states" but only exercises STOPPED → RUNNING → PAUSED → STOPPED, never ERROR.
**File**: `src/core/__tests__/engine-interface.test.ts`

---

### G-002 — Task 1.3.2: Spec requires `EngineMessage` types for Worker communication; `init` and `dispose` messages missing from the `EngineMessage` union

**Spec requirement**: "Define `EngineMessage` types for Worker communication: `{ type: 'step' }`, `{ type: 'start' }`, `{ type: 'stop' }`, `{ type: 'setSignal', netId, value }`, etc."
**What was found**: `src/core/engine-interface.ts` lines 108–129 define `EngineMessage` with `step`, `microStep`, `runToBreak`, `start`, `stop`, `reset`, `dispose`, and `setSignal`. The spec says "etc." which is ambiguous, so `reset` and `dispose` are arguably reasonable additions. However the `init` message is absent from the union — you cannot send a circuit initialisation command to a Worker engine via `EngineMessage`. Given that `init(circuit: CompiledCircuit)` is a lifecycle method, its absence from the Worker message protocol is a structural gap.
**File**: `src/core/engine-interface.ts`

---

### G-003 — Task 1.3.5: `errors.test.ts` does not import or test `OscillationError`

**Spec requirement**: Task 1.3.5 specifies five concrete error types. `OscillationError` was added to the file (see V-001) but the Phase 1 errors test file does not test it — it imports only `SimulationError`, `BurnException`, `BacktrackException`, `BitsException`, `NodeException`, and `PinException`.
**What was found**: `src/core/__tests__/errors.test.ts` line 20 lists the imports; `OscillationError` is absent. If it is present in the production file it should have test coverage; if it should not be present (see V-001) then this gap is a consequence of that violation.
**File**: `src/core/__tests__/errors.test.ts`

---

## Weak Tests

### WT-001 — `engine-interface.test.ts`: `typeof` check as sole assertion for method existence

**Test path**: `src/core/__tests__/engine-interface.test.ts::MockEngine measurement observer::addMeasurementObserver and removeMeasurementObserver exist on MockEngine`
**What's wrong**: The assertion `expect(typeof engine.addMeasurementObserver).toBe("function")` verifies only that a property called `addMeasurementObserver` exists and is of type function. It does not verify that calling the method has any meaningful effect, that the observer is actually registered, or that it is notified. This is a trivial presence check.
**Evidence**:
```typescript
it("addMeasurementObserver and removeMeasurementObserver exist on MockEngine", () => {
  expect(typeof engine.addMeasurementObserver).toBe("function");
  expect(typeof engine.removeMeasurementObserver).toBe("function");
});
```

---

### WT-002 — `engine-interface.test.ts`: `toContain` on method names tests implementation detail, not behaviour

**Test path**: `src/core/__tests__/engine-interface.test.ts::MockEngine measurement observer::addMeasurementObserver records the call`
**What's wrong**: The assertion `expect(engine.calls.map((c) => c.method)).toContain("addMeasurementObserver")` tests that the call recorder recorded a call with the method name "addMeasurementObserver". This is an implementation-detail assertion about the mock's internal call log, not about the desired behaviour (that an observer was registered and will be notified).
**Evidence**:
```typescript
engine.addMeasurementObserver(observer);
expect(engine.calls.map((c) => c.method)).toContain("addMeasurementObserver");
```

---

### WT-003 — `engine-interface.test.ts`: `EngineMessage` command type count is a magic number

**Test path**: `src/core/__tests__/engine-interface.test.ts::EngineMessage discriminated union::command types are string literals`
**What's wrong**: `expect(commands).toHaveLength(8)` verifies the count of items in a hand-constructed array against a magic number. It does not test that the discriminated union is exhaustive or that all variants are structurally correct. If a new message type is added, this test will fail for the wrong reason. The test should verify structural properties of each variant, not a count.
**Evidence**:
```typescript
const commands: EngineMessage["type"][] = [
  "step", "microStep", "runToBreak", "start", "stop", "reset", "dispose", "setSignal",
];
expect(commands).toHaveLength(8);
```

---

### WT-004 — `engine-interface.test.ts`: `EngineResponse` type count assertion

**Test path**: `src/core/__tests__/engine-interface.test.ts::EngineResponse discriminated union::response types cover all three variants`
**What's wrong**: Same pattern as WT-003. `expect(types).toHaveLength(3)` on a hand-constructed array of string literals counts items the test itself wrote. This trivially passes and does not test that the production union contains those variants.
**Evidence**:
```typescript
const types: EngineResponse["type"][] = ["stateChange", "error", "breakpoint"];
expect(types).toHaveLength(3);
```

---

### WT-005 — `circuit.test.ts`: `toBeInstanceOf(Set)` without content check

**Test path**: `src/core/__tests__/circuit.test.ts::Net::returns a read-only set from getPins()`
**What's wrong**: `expect(pins).toBeInstanceOf(Set)` verifies only the runtime type of the returned object, not that it is read-only or that it reflects the pins actually added. A stronger assertion would add a pin and verify the set contains it.
**Evidence**:
```typescript
it("returns a read-only set from getPins()", () => {
  const net = new Net();
  const pins = net.getPins();
  expect(pins).toBeInstanceOf(Set);
});
```

---

## Legacy References

None found.

---

## Additional Notes

The following items are observations rather than rule violations, recorded for completeness:

1. **`AbstractCircuitElement` base class** (`src/core/element.ts`, lines 148–210): The spec for task 1.3.1 specifies a `CircuitElement` **interface**. The implementation delivers both the interface and an abstract base class. This is consistent with the stated rationale in the file comment ("Using a class here is justified: every component is a genuine CircuitElement...") and provides value for the ~110 component implementations in later phases. It is not prohibited by the spec, which says only that `CircuitElement` must be an interface — and it is. The abstract class is an addition rather than a replacement.

2. **`EngineResponse` type** (`src/core/engine-interface.ts`, lines 139–142): Not in the task 1.3.2 spec listing, but is a logical companion to `EngineMessage` for Worker bidirectional communication. Reviewed as minor scope creep but not raised as a formal violation given the spec's use of "etc." in the Worker compatibility section.

3. **`propertyBagToJson` / `propertyBagFromJson` helpers** (`src/core/properties.ts`): The spec for task 1.2.3 requires Zod schemas but does not explicitly name these helper functions. They are a reasonable implementation of the spec requirement for "validation schemas for serialization boundaries." Not flagged as a violation.

4. **`THEME_COLORS` constant array and `COLOR_SCHEMES` registry** (`src/core/renderer-interface.ts`): Added during task 1.3.3. The spec requires "Built-in schemes: default, high contrast, monochrome. Switchable at runtime." These additions directly implement that requirement. Not flagged as a violation.

5. **`pin.ts` exports `Rotation` type** (lines 99–100): The spec for task 1.3.1 (`CircuitElement`) uses `Rotation` type (`0 | 1 | 2 | 3`). The implementation defines it in `pin.ts` and re-exports it appropriately. This is acceptable.
