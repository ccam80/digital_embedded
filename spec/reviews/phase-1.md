# Review Report: Phase 1 — Foundation & Type System

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 10 (1.1.1, 1.1.2, 1.2.1, 1.2.2, 1.2.3, 1.3.1, 1.3.2, 1.3.3, 1.3.4, 1.3.5) |
| Violations — critical | 3 |
| Violations — major | 4 |
| Violations — minor | 5 |
| Gaps | 3 |
| Weak tests | 18 |
| Legacy references | 0 |

**Verdict**: has-violations

---

## Violations

### V-001 — Critical: `// TODO` comments in production entry point `src/main.ts`

**File**: `src/main.ts`, lines 460, 465, 470
**Rule violated**: rules.md — "Never add `# TODO`, `# FIXME`, `# HACK` comments."
**Evidence**:
```typescript
document.getElementById('btn-step')?.addEventListener('click', () => {
  // TODO: compile circuit → engine.step()
  console.log('Step: engine compilation not yet wired');
});

document.getElementById('btn-run')?.addEventListener('click', () => {
  // TODO: compile circuit → engine.start()
  console.log('Run: engine compilation not yet wired');
});

document.getElementById('btn-stop')?.addEventListener('click', () => {
  // TODO: engine.stop()
  console.log('Stop: engine compilation not yet wired');
});
```
**Severity**: critical

---

### V-002 — Critical: `src/main.ts` is massively out of scope for Task 1.1.1

**File**: `src/main.ts`, lines 1–670
**Rule violated**: rules.md — scope creep; also rules.md — "Never mark work as deferred, TODO, or 'not implemented'." The completeness rule requires proceeding linearly through the task, not pre-implementing 5+ future phases.
**Evidence**: Task 1.1.1 specifies: "Create a minimal `src/main.ts` placeholder so the build works." The delivered file is 670 lines with full interactive application wiring. It imports from modules that belong to Phases 2, 4, and 6+:
```typescript
import { initApp } from './app/app-init.js';
import { screenToWorld, GRID_SPACING } from './editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from './editor/hit-test.js';
import { deleteSelection } from './editor/edit-operations.js';
import { loadDig } from './io/dig-loader.js';
import { serializeCircuit } from './io/save.js';
```
The file implements a complete canvas render loop, mouse/keyboard interaction state machine, zoom/pan, box selection, wire drawing, component placement, file I/O, and postMessage listener — none of which are Phase 1 deliverables. Progress.md describes this as "a minimal `src/main.ts` placeholder" which is factually inaccurate.
**Severity**: critical

---

### V-003 — Critical: `engine-interface.ts` delivers five undocumented surface areas beyond Task 1.3.2 spec

**File**: `src/core/engine-interface.ts`
**Rule violated**: rules.md — scope creep.
**Evidence**: The spec for Task 1.3.2 specifies exactly: `CompiledCircuit`, `EngineState`, `EngineChangeListener`, `SimulationEngine` (with 14 named methods), and `EngineMessage` types. The delivered file additionally provides:

1. `SimulationEvent` interface (lines 71–78) — not in spec:
```typescript
export interface SimulationEvent {
  readonly timestamp: bigint;
  readonly netId: number;
  readonly value: number;
}
```

2. `MeasurementObserver` interface (lines 92–97) — not in spec:
```typescript
export interface MeasurementObserver {
  onStep(stepCount: number): void;
  onReset(): void;
}
```

3. `EngineResponse` discriminated union (lines 139–142) — not in spec:
```typescript
export type EngineResponse =
  | { type: "stateChange"; state: EngineState }
  | { type: "error"; message: string }
  | { type: "breakpoint" };
```

4. `SnapshotId` type (line 152) — not in spec.

5. Full Snapshot API on `SimulationEngine` (lines 306–337): `saveSnapshot`, `restoreSnapshot`, `getSnapshotCount`, `clearSnapshots`, `setSnapshotBudget` — not in spec.

6. `addMeasurementObserver` / `removeMeasurementObserver` on `SimulationEngine` (lines 295–300) — not in spec.

**Severity**: critical

---

### V-004 — Major: `errors.ts` adds `OscillationError` beyond Task 1.3.5 spec

**File**: `src/core/errors.ts`, lines 163–191
**Rule violated**: rules.md — scope creep.
**Evidence**: The spec for Task 1.3.5 defines exactly five concrete error types: `BurnException`, `BacktrackException`, `BitsException`, `NodeException`, `PinException`. The delivered file contains a sixth:
```typescript
export class OscillationError extends SimulationError {
  /** Number of iterations attempted before giving up. */
  readonly iterations: number;
  ...
}
```
This class is not in the Phase 1 spec. `OscillationError` is untested in `errors.test.ts` (which imports only the five specified types), making the addition doubly problematic — scope creep with no test coverage.
**Severity**: major

---

### V-005 — Major: `renderer-interface.ts` adds `WIRE_ERROR` ThemeColor and a fourth color scheme beyond Task 1.3.3 spec

**File**: `src/core/renderer-interface.ts`, lines 35, 102–197
**Rule violated**: rules.md — scope creep.
**Evidence**:

1. `WIRE_ERROR` ThemeColor (line 35) not in spec. The spec enumerates: `WIRE`, `WIRE_HIGH`, `WIRE_LOW`, `WIRE_Z`, `WIRE_UNDEFINED`, `COMPONENT`, `COMPONENT_FILL`, `PIN`, `TEXT`, `GRID`, `BACKGROUND`, `SELECTION` — twelve values. The delivered type adds `"WIRE_ERROR"` as a thirteenth.

2. The spec says "Built-in schemes: default, high contrast, monochrome." Four schemes were delivered: `lightColorScheme`, `darkColorScheme`, `highContrastColorScheme`, `monochromeColorScheme`. A fifth registry entry (`"dark"`) is also distinct from `"default"`. The spec did not authorise a separate `lightColorScheme` / `darkColorScheme` split.
**Severity**: major

---

### V-006 — Major: `registry.ts` adds `SUBCIRCUIT` category, `defaultDelay` field, and extended `ComponentLayout` beyond Task 1.3.4 spec

**File**: `src/core/registry.ts`, lines 29, 76–83, 143–145
**Rule violated**: rules.md — scope creep.
**Evidence**:

1. `ComponentCategory.SUBCIRCUIT` (line 29) not in spec. The spec enumerates twelve categories; `SUBCIRCUIT` is a thirteenth.

2. `defaultDelay?: number` on `ComponentDefinition` (lines 143–145) not in spec.

3. `ComponentLayout` adds `stateOffset(componentIndex: number): number` (line 76) and `getProperty?(componentIndex: number, key: string): PropertyValue | undefined` (lines 81–83). The spec defines only `inputCount`, `inputOffset`, `outputCount`, `outputOffset`.
**Severity**: major

---

### V-007 — Major: `pin.ts` adds `ClockConfig` type beyond Task 1.2.2 spec

**File**: `src/core/pin.ts`, lines 63–74
**Rule violated**: rules.md — scope creep.
**Evidence**: The spec for Task 1.2.2 specifies `InverterConfig` as the per-pin inversion mechanism. It does not specify a separate `ClockConfig` abstraction. The `isClock` boolean on `Pin` and `isClockCapable` on `PinDeclaration` were in the spec, but not a symmetric `ClockConfig` type with `createClockConfig` and `isPinClock` helpers:
```typescript
export interface ClockConfig {
  readonly clockPins: ReadonlySet<string>;
}
export function createClockConfig(clockPinLabels: readonly string[]): ClockConfig { ... }
export function isPinClock(config: ClockConfig, label: string): boolean { ... }
```
**Severity**: major

---

### V-008 — Minor: `// TODO` comments visible in `src/main.ts` also contain `console.log` in production code

**File**: `src/main.ts`, lines 461, 466, 471
**Rule violated**: rules.md — Code Hygiene (debug output in production); `eslint.config.js` also enforces `'no-console': 'warn'`.
**Evidence**:
```typescript
console.log('Step: engine compilation not yet wired');
console.log('Run: engine compilation not yet wired');
console.log('Stop: engine compilation not yet wired');
```
These `console.log` calls are in production event handlers with no conditional guard. They are not test output — they fire in the browser on user interaction.
**Severity**: minor

---

### V-009 — Minor: Historical-provenance comment in `engine-interface.ts` uses banned word "previously"

**File**: `src/core/engine-interface.ts`, lines 282, 298
**Rule violated**: rules.md — "No historical-provenance comments."
**Evidence**:
```typescript
* Remove a previously registered listener. No-op if the listener was not
* registered.
```
and:
```typescript
* Remove a previously registered measurement observer.
```
The word "previously" describes a prior state of the system (what the caller did before). The rules ban "any comment describing what code replaced, what it used to do, why it changed, or where it came from." While this is JSDoc language, the rules make no exception for documentation comments. Flagged per literal rule text for reviewer judgment.
**Severity**: minor

---

### V-010 — Minor: `properties.ts` adds `getOrDefault` and `size` beyond Task 1.2.3 spec

**File**: `src/core/properties.ts`, lines 73–79, 109–111
**Rule violated**: rules.md — scope creep.
**Evidence**: Task 1.2.3 specifies exactly five `PropertyBag` methods: `get<T>`, `set`, `has`, `clone`, `entries`. Two extra members were added:
```typescript
getOrDefault<T extends PropertyValue>(key: string, defaultValue: T): T { ... }
get size(): number { return this._map.size; }
```
Neither appears in the spec.
**Severity**: minor

---

### V-011 — Minor: `pin.ts` adds `standardGatePinLayout` helper beyond Task 1.2.2 spec

**File**: `src/core/pin.ts`, lines 232–261
**Rule violated**: rules.md — scope creep.
**Evidence**: Task 1.2.2 specifies "N/S/E/W layout helpers: functions to compute pin positions for standard component orientations." The `layoutPinsOnFace` function satisfies this. `standardGatePinLayout` is an additional convenience wrapper:
```typescript
export function standardGatePinLayout(
  inputLabels: readonly string[],
  outputLabel: string,
  componentW: number,
  componentH: number,
  defaultBitWidth: number = 1,
): PinDeclaration[] { ... }
```
This function is not specified in Task 1.2.2.
**Severity**: minor

---

### V-012 — Minor: `circuit.ts` adds `isLocked` field to `CircuitMetadata` beyond Task 1.3.4 spec

**File**: `src/core/circuit.ts`, lines 78–79
**Rule violated**: rules.md — scope creep.
**Evidence**: The spec for Task 1.3.4 defines `CircuitMetadata` with: `name`, `description`, `test data references`, `measurement ordering`, `isGeneric`. The delivered interface adds:
```typescript
/** When true, users may not add, move, delete, or edit elements or wires. */
isLocked: boolean;
```
This field is not in the Phase 1 spec.
**Severity**: minor

---

## Gaps

### G-001 — Task 1.3.2: `EngineState.ERROR` state is defined but untestable via MockEngine; test title is false

**Spec requirement**: Task 1.3.2 specifies `EngineState` enum with four values: `STOPPED`, `RUNNING`, `PAUSED`, `ERROR`. Spec also requires: "Unit tests: verify mock engine implements the interface correctly, state transitions are valid."
**What was found**: `EngineState.ERROR` is defined (line 46 of `engine-interface.ts`) but `MockEngine` has no method or path that sets `_state = EngineState.ERROR`. No test demonstrates or validates an ERROR state transition. The test at `engine-interface.test.ts` line 69 is titled "engine transitions through all four states" but only exercises three states (STOPPED, RUNNING, PAUSED):
```typescript
it("engine transitions through all four states", () => {
  expect(engine.getState()).toBe("STOPPED");
  engine.start();  // → RUNNING
  expect(engine.getState()).toBe("RUNNING");
  engine.stop();   // → PAUSED
  expect(engine.getState()).toBe("PAUSED");
  engine.reset();  // → STOPPED
  expect(engine.getState()).toBe("STOPPED");
});
```
**File**: `src/core/__tests__/engine-interface.test.ts`, line 69; `src/test-utils/mock-engine.ts`

---

### G-002 — Task 1.3.5: `OscillationError` present in `errors.ts` but absent from `errors.test.ts`

**Spec requirement**: Task 1.3.5 requires "Unit tests: each error type can be constructed, has the correct name, carries context fields, is an instance of both its own type and `SimulationError`."
**What was found**: `OscillationError` was added to `src/core/errors.ts` (see V-004) but `src/core/__tests__/errors.test.ts` does not import or test it. The import list at line 20 of the test file is:
```typescript
import {
  SimulationError,
  BurnException,
  BacktrackException,
  BitsException,
  NodeException,
  PinException,
} from "../errors.js";
```
`OscillationError` is absent. If this class is to remain in the file (as scope-creep resolution may decide), it lacks any test coverage.
**File**: `src/core/__tests__/errors.test.ts`

---

### G-003 — Task 1.3.2: `init` command absent from `EngineMessage` union, preventing Worker initialisation

**Spec requirement**: Task 1.3.2 requires: "Define `EngineMessage` types for Worker communication: `{ type: 'step' }`, `{ type: 'start' }`, `{ type: 'stop' }`, `{ type: 'setSignal', netId, value }`, etc." and "Control via message-passable commands."
**What was found**: `EngineMessage` at `src/core/engine-interface.ts` lines 108–129 covers: `step`, `microStep`, `runToBreak`, `start`, `stop`, `reset`, `dispose`, `setSignal`. There is no `init` message variant. Since `init(circuit: CompiledCircuit)` is the first lifecycle method and must be called before any other operation, the absence of an `init` message means a Worker-mode engine cannot be initialised via `EngineMessage`. The spec's "Control via message-passable commands" requirement is only partially met.
**File**: `src/core/engine-interface.ts`, lines 108–129

---

## Weak Tests

### WT-001
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::drawLine is callable with four numbers`
**Problem**: `not.toThrow()` is the sole assertion. A no-op implementation would pass. No verification that the draw call was recorded or that correct arguments were captured by the MockRenderContext.
**Evidence**: `expect(() => ctx.drawLine(0, 0, 100, 100)).not.toThrow();`

---

### WT-002
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::drawRect is callable with four numbers and a boolean`
**Problem**: Same pattern — `not.toThrow()` only.
**Evidence**:
```typescript
expect(() => ctx.drawRect(10, 20, 50, 60, true)).not.toThrow();
expect(() => ctx.drawRect(10, 20, 50, 60, false)).not.toThrow();
```

---

### WT-003
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::drawCircle is callable with cx, cy, radius, filled`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => ctx.drawCircle(5, 5, 10, true)).not.toThrow();`

---

### WT-004
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::drawArc is callable with cx, cy, radius, startAngle, endAngle`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => ctx.drawArc(0, 0, 20, 0, Math.PI)).not.toThrow();`

---

### WT-005
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::drawPolygon is callable with readonly Point array and boolean`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => ctx.drawPolygon(points, false)).not.toThrow();`

---

### WT-006
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::drawPath is callable with PathData`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => ctx.drawPath(path)).not.toThrow();`

---

### WT-007
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::drawText is callable with string, x, y, TextAnchor`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => ctx.drawText("test", 5, 5, anchor)).not.toThrow();`

---

### WT-008
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::save and restore are callable`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => { ctx.save(); ctx.restore(); }).not.toThrow();`

---

### WT-009
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::translate, rotate, scale are callable`
**Problem**: `not.toThrow()` only for all three transforms.
**Evidence**:
```typescript
expect(() => ctx.translate(10, 20)).not.toThrow();
expect(() => ctx.rotate(Math.PI / 4)).not.toThrow();
expect(() => ctx.scale(2, 3)).not.toThrow();
```

---

### WT-010
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::setColor is callable with any ThemeColor`
**Problem**: `not.toThrow()` only. A no-op setColor would pass.
**Evidence**: `expect(() => ctx.setColor(color)).not.toThrow();`

---

### WT-011
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::setLineWidth is callable with a number`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => ctx.setLineWidth(2)).not.toThrow();`

---

### WT-012
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::setFont is callable with a FontSpec`
**Problem**: `not.toThrow()` only.
**Evidence**: `expect(() => ctx.setFont(font)).not.toThrow();`

---

### WT-013
**Test path**: `src/core/__tests__/renderer-interface.test.ts::RenderContext interface method signatures::setLineDash is callable with a number array`
**Problem**: `not.toThrow()` only.
**Evidence**:
```typescript
expect(() => ctx.setLineDash([4, 2])).not.toThrow();
expect(() => ctx.setLineDash([])).not.toThrow();
```

---

### WT-014
**Test path**: `src/core/__tests__/renderer-interface.test.ts::COLOR_SCHEMES::schemes are switchable at runtime — resolving same color through different schemes gives different results`
**Problem**: `expect(unique.size).toBeGreaterThan(1)` only requires two of the three tested schemes to differ for BACKGROUND. Does not verify all three are distinct, nor any semantic colour property.
**Evidence**:
```typescript
const results = schemes.map((s) => s.resolve("BACKGROUND"));
const unique = new Set(results);
expect(unique.size).toBeGreaterThan(1);
```

---

### WT-015
**Test path**: `src/core/__tests__/renderer-interface.test.ts::COLOR_SCHEMES::each scheme in COLOR_SCHEMES resolves all ThemeColors without throwing`
**Problem**: `not.toThrow()` only — does not assert on resolved colour values.
**Evidence**: `expect(() => scheme.resolve(color)).not.toThrow();`

---

### WT-016
**Test path**: `src/core/__tests__/engine-interface.test.ts::SimulationEngine interface compliance::all required methods are callable on MockEngine`
**Problem**: Calls many methods in sequence but only checks return values of `getSignalRaw` and `getSignalValue`. All other method calls are unchecked. This is a smoke test masquerading as a compliance test.
**Evidence**:
```typescript
engine.step();
engine.microStep();
engine.runToBreak();
engine.start();
engine.stop();
engine.reset();
expect(engine.getSignalRaw(0)).toBe(0);
expect(engine.getSignalValue(0).toNumber()).toBe(0);
engine.dispose();
```

---

### WT-017
**Test path**: `src/core/__tests__/engine-interface.test.ts::EngineState::engine transitions through all four states`
**Problem**: Test title claims "all four states" but only exercises STOPPED, RUNNING, PAUSED. ERROR state is never entered. The test is misleadingly named and provides false assurance about ERROR-state coverage.
**Evidence**:
```typescript
expect(engine.getState()).toBe("STOPPED");
engine.start();
expect(engine.getState()).toBe("RUNNING");
engine.stop();
expect(engine.getState()).toBe("PAUSED");
engine.reset();
expect(engine.getState()).toBe("STOPPED");
// ERROR state: never reached
```

---

### WT-018
**Test path**: `src/core/__tests__/circuit.test.ts::Net::returns a read-only set from getPins()`
**Problem**: `expect(pins).toBeInstanceOf(Set)` verifies only the runtime type, not that the set is populated with the pin that was added, nor that it reflects changes. The test adds a pin before the assertion but the `toBeInstanceOf(Set)` check does not verify the pin is in the returned set.
**Evidence**:
```typescript
it("returns a read-only set from getPins()", () => {
  const net = new Net();
  const pin: Pin = { ... };
  net.addPin(pin);
  const pins = net.getPins();
  expect(pins).toBeInstanceOf(Set);
  expect(pins.size).toBe(1);
  expect(pins.has(pin)).toBe(true);
});
```
Note: This test is better than a bare `toBeInstanceOf` — the additional `size` and `has` assertions rescue it partially. The `toBeInstanceOf(Set)` line itself is the weak assertion. Flagged for completeness.

---

## Legacy References

None found.
