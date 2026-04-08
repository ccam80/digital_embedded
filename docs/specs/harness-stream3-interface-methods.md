# Stream 3 Spec: Query/Discovery/Filtering Layer

**Stream:** 3 of 3  
**Depends on:** Stream 1 (extended capture fields), Stream 2 (MCP tool wrappers)  
**Provides to:** Stream 2 (all query methods — every return type is JSON-serializable)

---

## Hard Constraints

- No legacy shims. No fallbacks. No graceful degradation.
- All Stream 1 fields are present. Treat missing fields as implementation bugs in Stream 1, not cases to handle here.
- Every return type must be JSON-serializable with no `Map`, `Float64Array`, `NaN`, or `Infinity` in output.
- No optional method implementations. All 17 new methods and all 5 enhanced methods are mandatory.

---

## Stream 1 Fields Assumed Present

The following fields are populated by Stream 1 and are used without null checks:

| Field | Location | Type |
|-------|----------|------|
| `state1Slots` | `ElementStateSnapshot` | `Record<string, number>` |
| `state2Slots` | `ElementStateSnapshot` | `Record<string, number>` |
| `preSolveRhs` | `IterationSnapshot` | `Float64Array` |
| `limitingEvents` | `IterationSnapshot` | `LimitingEvent[]` |
| `convergenceFailedElements` | `IterationSnapshot` | `string[]` |
| `ngspiceConvergenceFailedDevices` | `IterationSnapshot` | `string[]` |
| `integrationCoefficients` | `StepSnapshot` | `IntegrationCoefficients` |
| `analysisPhase` | `StepSnapshot` | `string` |
| `matrixRowLabels` | `TopologySnapshot` | `string[]` |
| `matrixColLabels` | `TopologySnapshot` | `string[]` |
| `type` | `TopologySnapshot.elements[i]` | `string` (populated by capture fix, see below) |

### Stream 1 Type Additions to `types.ts`

Stream 1 adds these to existing interfaces. Stream 3 uses them without null guards:

```typescript
// Added to ElementStateSnapshot by Stream 1:
state1Slots: Record<string, number>;                    // slot -> value at previous timepoint (CKTstate1)
state2Slots: Record<string, number>;                    // slot -> value two timepoints ago (CKTstate2)

// Added to IterationSnapshot by Stream 1:
preSolveRhs: Float64Array;                              // CKTrhs copy before SMPsolve
limitingEvents: LimitingEvent[];                        // per-junction limiting applied this iter
convergenceFailedElements: string[];                    // our engine: labels that failed convTest
ngspiceConvergenceFailedDevices: string[];              // ngspice: device names that failed

// Added to StepSnapshot by Stream 1:
integrationCoefficients: IntegrationCoefficients;       // ag0, ag1, method, order
analysisPhase: string;                                  // "dcop" | "tran-init" | "tran-float"

// Added to TopologySnapshot by Stream 1:
matrixRowLabels: string[];                              // label per matrix row (index 0..matrixSize-1)
matrixColLabels: string[];                              // label per matrix col
```

### Stream 1 Supporting Types (defined in Stream 1, used here)

```typescript
// In types.ts (added by Stream 1):
// LimitingEvent is Stream 1's canonical per-engine type. Each session (ours and ngspice)
// stores its own array of LimitingEvent on IterationSnapshot.limitingEvents. The dual-engine
// comparison is built at query time by getLimitingComparison(), not stored in the type.
export interface LimitingEvent {
  elementIndex: number;
  label: string;
  junction: string;
  limitType: "pnjlim" | "fetlim" | "limvds";
  vBefore: number;
  vAfter: number;
  wasLimited: boolean;
}

export interface IntegrationCoefficients {
  ours: { ag0: number; ag1: number; method: "backwardEuler" | "trapezoidal" | "gear2"; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
}
```

---

## Capture Layer Fix (Stream 3 Prerequisite)

`captureTopology()` in `capture.ts` currently leaves `type` undefined on most elements. Stream 3 requires it populated.

### Required Change to `captureTopology()` in `capture.ts`

```typescript
// Current (Stream 1 state):
elements: compiled.elements.map((el, i) => ({
  index: i,
  label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
  isNonlinear: el.isNonlinear,
  isReactive: el.isReactive,
  pinNodeIds: el.pinNodeIds,
})),

// Required (Stream 3):
elements: compiled.elements.map((el, i) => {
  const ce = compiled.elementToCircuitElement?.get(i);
  const typeId = ce?.typeId ?? "";
  return {
    index: i,
    label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
    type: normalizeDeviceType(typeId),   // <-- new: import normalizeDeviceType from device-mappings.ts
    isNonlinear: el.isNonlinear,
    isReactive: el.isReactive,
    pinNodeIds: el.pinNodeIds,
  };
}),
```

The `type` field on `TopologySnapshot.elements[i]` is now always a non-empty string (falls back to `"unknown"` for unrecognized typeIds).

---

## New Utility Module: `glob.ts`

**File:** `src/solver/analog/__tests__/harness/glob.ts`

```typescript
/**
 * Glob pattern matching for slot names.
 * Supports: * (any chars), ? (single char), case-insensitive, multiple patterns OR'd.
 */

/**
 * Compile a list of glob patterns into a single matcher function.
 * Empty patterns array matches nothing (returns false always).
 */
export function compileSlotMatcher(patterns: string[]): (slotName: string) => boolean;

/**
 * Test a single slot name against one or more glob patterns.
 * Returns true if any pattern matches (OR semantics).
 */
export function matchSlotPattern(slotName: string, patterns: string[]): boolean;
```

### Glob Conversion Rules

| Glob token | Regex equivalent |
|-----------|-----------------|
| `*` | `.*` |
| `?` | `.` |
| All other chars | `escapeRegex(char)` |

- Patterns are anchored: `^` + converted + `$`
- Case-insensitive flag (`i`) applied
- Multiple patterns are OR'd: `compileSlotMatcher(["Q_*", "CCAP*"])` matches slot if either pattern matches

### Behavior Guarantees

- `compileSlotMatcher([])` → always returns `false`
- `compileSlotMatcher(["*"])` → always returns `true`
- `matchSlotPattern("Q_BE", ["Q_*"])` → `true`
- `matchSlotPattern("q_be", ["Q_*"])` → `true` (case-insensitive)
- `matchSlotPattern("VBE", ["Q_*"])` → `false`
- `matchSlotPattern("VBE", ["V?E", "V??"])` → `true` (matches `V?E`)
- `matchSlotPattern("GEQ", [])` → `false`

---

## New Utility Module: `format.ts`

**File:** `src/solver/analog/__tests__/harness/format.ts`

```typescript
/**
 * Formatting and serialization utilities for harness query results.
 */
import type { ComparedValue } from "./types.js";

/**
 * Format a single ComparedValue as a compact human-readable string.
 * Format: "ours=<val> ng=<val> Δ=<delta> [PASS|FAIL]"
 * Uses exponential notation with `precision` significant digits (default 6).
 * NaN values rendered as "NaN".
 */
export function formatComparedValue(cv: ComparedValue, precision?: number): string;

/**
 * Rich formatted form with individual fields as strings.
 */
export interface FormattedComparedValue {
  ours: string;
  ngspice: string;
  delta: string;
  absDelta: string;
  relDelta: string;
  withinTol: boolean;
  summary: string;    // same as formatComparedValue output
}

export function formatCV(cv: ComparedValue, precision?: number): FormattedComparedValue;

/**
 * Format a Record<string, ComparedValue> as a multi-line table.
 * Columns: slot name, ours, ngspice, absDelta, PASS/FAIL.
 * Rows sorted by absDelta descending (worst first).
 */
export function formatComparedTable(
  entries: Record<string, ComparedValue>,
  precision?: number,
): string;

/**
 * Convert a Map<K, V> to a plain Record<string, V> for JSON serialization.
 * Keys are converted via String(key).
 */
export function mapToRecord<V>(map: Map<number | string, V>): Record<string, V>;

/**
 * Convert a Float64Array to a plain number[] for JSON serialization.
 * NaN → null, Infinity → null (via JSON-safe coercion).
 */
export function float64ToArray(arr: Float64Array): (number | null)[];
```

### JSON Serialization Rules (applied by `toJSON` and `float64ToArray`)

| Input value | JSON output |
|------------|-------------|
| `NaN` | `null` |
| `Infinity` | `null` |
| `-Infinity` | `null` |
| `Map<K,V>` | `Record<string, V>` (via `mapToRecord`) |
| `Float64Array` | `(number \| null)[]` (via `float64ToArray`) |
| `ComparedValue` | plain object, no conversion needed |
| `readonly number[]` | `number[]` (spread) |

---

## `normalizeDeviceType()` — Addition to `device-mappings.ts`

Add to **`src/solver/analog/__tests__/harness/device-mappings.ts`**:

```typescript
/**
 * Normalize a circuit element typeId to a canonical device type string
 * matching the keys in DEVICE_MAPPINGS.
 *
 * @param typeId - The typeId from CircuitElement (e.g. "NpnBJT", "NMOS")
 * @returns Canonical lowercase device type ("bjt", "mosfet", "diode", etc.)
 *          or "unknown" if unrecognized.
 */
export function normalizeDeviceType(typeId: string): string;
```

### Normalization Table

| `typeId` | Canonical type |
|---------|---------------|
| `"NpnBJT"` | `"bjt"` |
| `"PnpBJT"` | `"bjt"` |
| `"NMOS"` | `"mosfet"` |
| `"PMOS"` | `"mosfet"` |
| `"NJFET"` | `"jfet"` |
| `"PJFET"` | `"jfet"` |
| `"Diode"` | `"diode"` |
| `"Zener"` | `"diode"` |
| `"Varactor"` | `"varactor"` |
| `"TunnelDiode"` | `"tunnel-diode"` |
| `"Capacitor"` | `"capacitor"` |
| `"Inductor"` | `"inductor"` |
| `"Resistor"` | `"resistor"` |
| `"DcVoltageSource"` | `"vsource"` |
| `"AcVoltageSource"` | `"vsource"` |
| `"DcCurrentSource"` | `"isource"` |
| `"AcCurrentSource"` | `"isource"` |
| `"SCR"` | `"scr"` |
| `"Triac"` | `"triac"` |
| anything else | `"unknown"` |

---

## New Types in `types.ts` (ALL mandatory)

Add all of the following to **`src/solver/analog/__tests__/harness/types.ts`**. These are pure additions — nothing existing is removed or changed.

```typescript
// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationOpts {
  /** Skip first N results. Default: 0. */
  offset?: number;
  /** Return at most N results. Default: unlimited for discovery methods,
   *  100 for getDivergences. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Discovery types
// ---------------------------------------------------------------------------

export interface ComponentInfo {
  /** Human-readable label (e.g. "Q1", "R2"). */
  label: string;
  /** Canonical device type (e.g. "bjt", "capacitor"). "unknown" if unrecognized. */
  deviceType: string;
  /** Available state slot names for this component. Empty array if not pool-backed. */
  slotNames: string[];
  /** Pin node labels (e.g. ["Q1:B", "Q1:C", "Q1:E"]). */
  pinLabels: string[];
}

export interface NodeInfo {
  /** Canonical label (e.g. "Q1:C", "R1:A/C1:A"). */
  label: string;
  /** Our MNA node index (1-based, matching TopologySnapshot.nodeLabels key). */
  ourIndex: number;
  /** ngspice node number (-1 if no mapping exists). */
  ngspiceIndex: number;
  /** Labels of components connected to this node. */
  connectedComponents: string[];
}

// ---------------------------------------------------------------------------
// Component slot query types
// ---------------------------------------------------------------------------

/** Snapshot mode: one step, one ComparedValue per matched slot. */
export interface ComponentSlotsSnapshot {
  mode: "snapshot";
  label: string;
  stepIndex: number;
  simTime: number;
  /** Matched slot name → ComparedValue from the final (converged) iteration. */
  slots: Record<string, ComparedValue>;
  /** Slot names that matched the glob patterns. */
  matchedSlots: string[];
  /** Total slots available on this component (before pattern filter). */
  totalSlots: number;
}

/** Trace mode: all steps, converged values only. */
export interface ComponentSlotsTrace {
  mode: "trace";
  label: string;
  /** Step count after stepsRange filter (if any). */
  totalSteps: number;
  /** Matched slot names. */
  matchedSlots: string[];
  /** Per-step converged values for each matched slot. */
  steps: Array<{
    stepIndex: number;
    simTime: number;
    /** slot name → ComparedValue (final iteration of this step). */
    slots: Record<string, ComparedValue>;
  }>;
}

export type ComponentSlotsResult = ComponentSlotsSnapshot | ComponentSlotsTrace;

// ---------------------------------------------------------------------------
// Divergence report types
// ---------------------------------------------------------------------------

export type DivergenceCategory = "voltage" | "state" | "rhs" | "matrix";

export interface DivergenceEntry {
  stepIndex: number;
  iteration: number;
  simTime: number;
  category: DivergenceCategory;
  /** For voltage/rhs: node label. For state: "ComponentLabel:slotName". For matrix: "row,col". */
  label: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  relDelta: number;
  withinTol: boolean;
  /** For state entries: component label. Null for voltage/rhs/matrix. */
  componentLabel: string | null;
  /** For state entries: slot name. Null for voltage/rhs/matrix. */
  slotName: string | null;
}

export interface DivergenceReport {
  /** Total out-of-tolerance entries (before pagination). */
  totalCount: number;
  /** Worst entry per category (absDelta). Null if no divergences in that category. */
  worstByCategory: Record<DivergenceCategory, DivergenceEntry | null>;
  /** Paginated entries sorted by absDelta descending. */
  entries: DivergenceEntry[];
}

// ---------------------------------------------------------------------------
// Slot trace
// ---------------------------------------------------------------------------

export interface SlotTrace {
  label: string;
  slotName: string;
  /** Total steps (before pagination). */
  totalSteps: number;
  /** Converged value per accepted step (final iteration). */
  steps: Array<{
    stepIndex: number;
    simTime: number;
    value: ComparedValue;
  }>;
}

// ---------------------------------------------------------------------------
// State history
// ---------------------------------------------------------------------------

export interface StateHistoryReport {
  label: string;
  stepIndex: number;
  iteration: number;
  /** state0 slots from our engine. */
  state0: Record<string, number>;
  /** state1 slots from our engine (previous step accepted values). */
  state1: Record<string, number>;
  /** state2 slots from our engine (two steps back). */
  state2: Record<string, number>;
  /** state0 slots from ngspice. */
  ngspiceState0: Record<string, number>;
  /** state1 slots from ngspice (CKTstate1). */
  ngspiceState1: Record<string, number>;
  /** state2 slots from ngspice (CKTstate2). */
  ngspiceState2: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Labeled matrix / RHS
// ---------------------------------------------------------------------------

export interface LabeledMatrixEntry {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  withinTol: boolean;
}

export interface LabeledMatrix {
  stepIndex: number;
  iteration: number;
  matrixSize: number;
  entries: LabeledMatrixEntry[];
}

export interface LabeledRhsEntry {
  index: number;
  label: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  withinTol: boolean;
}

export interface LabeledRhs {
  stepIndex: number;
  iteration: number;
  entries: LabeledRhsEntry[];
}

// ---------------------------------------------------------------------------
// Matrix comparison
// ---------------------------------------------------------------------------

export interface MatrixComparisonEntry {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  ours: number;
  ngspice: number;
  delta: number;
  absDelta: number;
  withinTol: boolean;
}

export interface MatrixComparison {
  stepIndex: number;
  iteration: number;
  filter: "all" | "mismatches";
  totalEntries: number;
  mismatchCount: number;
  maxAbsDelta: number;
  entries: MatrixComparisonEntry[];
}

// ---------------------------------------------------------------------------
// Integration coefficients
// ---------------------------------------------------------------------------

export interface IntegrationCoefficientsReport {
  stepIndex: number;
  ours: { ag0: number; ag1: number; method: string; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
  /** True if method and order agree between engines. */
  methodMatch: boolean;
  ag0Compared: ComparedValue;
  ag1Compared: ComparedValue;
}

// ---------------------------------------------------------------------------
// Junction limiting
// ---------------------------------------------------------------------------

export interface JunctionLimitingEntry {
  junction: string;
  ourPreLimit: number;
  ourPostLimit: number;
  ourDelta: number;        // ourPostLimit - ourPreLimit
  ngspicePreLimit: number;
  ngspicePostLimit: number;
  ngspiceDelta: number;   // ngspicePostLimit - ngspicePreLimit
  /** Signed difference of applied limiting: ourDelta - ngspiceDelta */
  limitingDiff: number;
}

export interface LimitingComparisonReport {
  label: string;
  stepIndex: number;
  iteration: number;
  /** One entry per junction that had a limiting event in either engine. */
  junctions: JunctionLimitingEntry[];
  /** True if no limiting events found for this component at this iteration. */
  noEvents: boolean;
}

// ---------------------------------------------------------------------------
// Convergence detail
// ---------------------------------------------------------------------------

export interface ConvergenceElementEntry {
  label: string;
  deviceType: string;
  ourConverged: boolean;
  ngspiceConverged: boolean;
  /** Worst absDelta across all slots for this component at this iteration. */
  worstDelta: number;
  /** True if both engines agree on convergence status. */
  agree: boolean;
}

export interface ConvergenceDetailReport {
  stepIndex: number;
  iteration: number;
  ourNoncon: number;
  ngspiceNoncon: number;
  ourGlobalConverged: boolean;
  ngspiceGlobalConverged: boolean;
  elements: ConvergenceElementEntry[];
  /** Count of elements where engines disagree on convergence. */
  disagreementCount: number;
}

// ---------------------------------------------------------------------------
// Enhanced StepEndReport component entry
// ---------------------------------------------------------------------------

/** Replaces Record<string, ComparedValue> in StepEndReport.components */
export interface StepEndComponentEntry {
  deviceType: string;
  slots: Record<string, ComparedValue>;
}

// ---------------------------------------------------------------------------
// Session report (toJSON output)
// ---------------------------------------------------------------------------

export interface SessionReport {
  analysis: "dcop" | "tran";
  stepCount: { ours: number; ngspice: number };
  nodeCount: number;
  elementCount: number;
  summary: {
    totalCompared: number;
    passed: number;
    failed: number;
    firstDivergence: {
      stepIndex: number;
      iterationIndex: number;
      simTime: number;
      worstLabel: string;
      absDelta: number;
    } | null;
    perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }>;
    integrationMethod: string | null;
    stateHistoryIssues: { state1Mismatches: number; state2Mismatches: number };
  };
  steps: Array<{
    stepIndex: number;
    simTime: number;
    dt: number;
    converged: { ours: boolean; ngspice: boolean };
    iterationCount: { ours: number; ngspice: number };
    nodes: Record<string, {
      ours: number | null;
      ngspice: number | null;
      absDelta: number | null;
      withinTol: boolean;
    }>;
    components: Record<string, {
      deviceType: string;
      slots: Record<string, {
        ours: number | null;
        ngspice: number | null;
        absDelta: number | null;
        withinTol: boolean;
      }>;
    }>;
  }>;
}
```

---

## Enhanced Existing Types in `types.ts`

### `StepEndReport` — `components` field type change

```typescript
// Before (Stream 1):
components: Record<string, Record<string, ComparedValue>>;

// After (Stream 3):
components: Record<string, StepEndComponentEntry>;
```

This is a breaking change to the existing `StepEndReport` interface. All callers of `getStepEnd()` must update to access `entry.slots` instead of `entry` directly.

### `IterationReport` — `perElementConvergence` field addition

```typescript
// Add to IterationReport:
perElementConvergence: Array<{
  label: string;
  deviceType: string;
  converged: boolean;
  worstDelta: number;
}>;
```

### `SessionSummary` — three new fields

```typescript
// Add to SessionSummary:
perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }>;
integrationMethod: string | null;   // from first transient step's integrationCoefficients.ours.method
stateHistoryIssues: {
  state1Mismatches: number;   // count of steps where any state1 slot differs beyond tolerance
  state2Mismatches: number;   // count of steps where any state2 slot differs beyond tolerance
};
```

---

## New Methods on `ComparisonSession`

All new methods are public instance methods unless noted. All must be implemented — none are optional.

### Method 1: `listComponents(opts?: PaginationOpts): ComponentInfo[]`

Returns one `ComponentInfo` per element in `_ourTopology.elements`, ordered by element index.

**Implementation:**
1. For each element in `_ourTopology.elements`, build `ComponentInfo`:
   - `label`: `element.label`
   - `deviceType`: `element.type` (populated by capture fix above)
   - `slotNames`: look up element in `_engine.elements` by index; if pool-backed, return `el.stateSchema.slots.map(s => s.name)`; else `[]`
   - `pinLabels`: for each `nodeId` in `element.pinNodeIds`, look up `_ourTopology.nodeLabels.get(nodeId) ?? ""`, filter empty strings
2. Apply `PaginationOpts`: slice after building full list.
3. Does not require `_ensureRun()` — topology is available after `init()`.

**Return:** `ComponentInfo[]`

---

### Method 2: `listNodes(opts?: PaginationOpts): NodeInfo[]`

Returns one `NodeInfo` per entry in `_ourTopology.nodeLabels`, ordered by node index ascending.

**Implementation:**
1. Collect all `(nodeId, label)` pairs from `_ourTopology.nodeLabels`.
2. For each node:
   - `label`: from `nodeLabels`
   - `ourIndex`: nodeId
   - `ngspiceIndex`: from `_nodeMap.find(m => m.ourIndex === nodeId)?.ngspiceIndex ?? -1`
   - `connectedComponents`: scan `_ourTopology.elements`; for each element whose `pinNodeIds` includes this nodeId, add `element.label` to the list
3. Sort by `ourIndex` ascending.
4. Apply `PaginationOpts`.
5. Does not require `_ensureRun()` — works after `init()`. NodeMap may be empty before run (ngspiceIndex will be -1 for all).

**Return:** `NodeInfo[]`

---

### Method 3: `getComponentsByType(type: string): string[]`

Returns component labels whose `deviceType` matches `type` (case-insensitive).

**Implementation:**
1. Normalize `type` to lowercase.
2. Filter `_ourTopology.elements` where `element.type.toLowerCase() === type`.
3. Return `element.label` for each match.
4. Does not require `_ensureRun()`.

**Return:** `string[]` — may be empty.

---

### Method 4: `getComponentSlots(label: string, patterns: string[], opts?: { step?: number } & PaginationOpts): ComponentSlotsResult`

Returns state slot values for one component, filtered by glob patterns.

**Implementation:**
1. Call `_ensureRun()`.
2. Look up component in `_ourTopology.elements` by label (case-insensitive). Throw `Error` if not found: `"Component not found: <label>"`.
3. Compile matcher: `const matches = compileSlotMatcher(patterns)`.
4. If `opts?.step !== undefined` (snapshot mode):
   - Get `ourStep = _ourSession!.steps[opts.step]`. Throw `Error` if out of range: `"Step out of range: <step>"`.
   - Get `ngStep = _ngSessionAligned()?.steps[opts.step]`.
   - From the final iteration of each step, extract element states for this label.
   - Filter slots by `matches(slotName)`.
   - Return `ComponentSlotsSnapshot`.
5. If `opts?.step` is `undefined` (trace mode):
   - Collect all steps. Apply `stepsRange` via `PaginationOpts` on the step list.
   - For each step, take final iteration, extract element states, filter by patterns.
   - Return `ComponentSlotsTrace`.
6. `PaginationOpts.offset/limit` apply to the **slots** in snapshot mode and to **steps** in trace mode.

**Errors:**
- `"Component not found: <label>"`
- `"Step out of range: <step>"` (snapshot mode only)

---

### Method 5: `getDivergences(opts?: { step?: number; component?: string; threshold?: number } & PaginationOpts): DivergenceReport`

Returns only out-of-tolerance values from all comparisons, sorted by `absDelta` descending.

**Implementation:**
1. Call `_ensureRun()`.
2. Build `allEntries: DivergenceEntry[]` by scanning `_getComparisons()`:
   - `step` filter: if `opts?.step !== undefined`, only include entries from that step.
   - `component` filter: if `opts?.component !== undefined`, only include state entries for that component.
   - For each `ComparisonResult`:
     - Add `DivergenceEntry` for each `voltageDiff` where `!withinTol` (category: `"voltage"`, componentLabel: null, slotName: null).
     - Add `DivergenceEntry` for each `rhsDiff` where `!withinTol` (category: `"rhs"`).
     - Add `DivergenceEntry` for each `matrixDiff` (all are already out-of-tol in `matrixDiffs`; category: `"matrix"`, label: `"row,col"`).
     - Add `DivergenceEntry` for each `stateDiff` where `!withinTol` (category: `"state"`, label: `"ComponentLabel:slotName"`).
   - Apply `threshold` override: if `opts?.threshold !== undefined`, only include entries where `absDelta > opts.threshold`.
3. Sort all entries by `absDelta` descending.
4. Build `worstByCategory`: for each category, find the entry with maximum `absDelta`.
5. Apply `PaginationOpts` to `allEntries` for the returned `entries` slice.
6. Default `limit`: 100 if not specified.

**Return:** `DivergenceReport` with:
- `totalCount`: total before pagination
- `worstByCategory`: one `DivergenceEntry | null` per category
- `entries`: paginated slice

---

### Method 6: `getStepEndRange(fromStep: number, toStep: number): StepEndReport[]`

Batch version of `getStepEnd`. Inclusive range `[fromStep, toStep]`.

**Implementation:**
1. Call `_ensureRun()`.
2. Clamp to valid step range: `Math.max(0, fromStep)` to `Math.min(_ourSession!.steps.length - 1, toStep)`.
3. For each step index in range, call `this.getStepEnd(stepIndex)`.
4. Return array of results.

**Return:** `StepEndReport[]` — may be empty if range is out of bounds.

---

### Method 7: `traceComponentSlot(label: string, slotName: string, opts?: PaginationOpts): SlotTrace`

Single slot timeseries across all steps (converged values only — final iteration per step).

**Implementation:**
1. Call `_ensureRun()`.
2. Look up component by label (case-insensitive). Throw `Error` if not found.
3. For each step in `_ourSession!.steps`:
   - Take the final iteration.
   - Find `elementStates` entry for this label.
   - If slot `slotName` exists: get our value; look up ngspice via aligned session.
   - Build `ComparedValue` using `_slotTolerance(slotName)`.
4. Collect all into steps array. `totalSteps` = count before pagination.
5. Apply `PaginationOpts` to the steps array.

**Return:** `SlotTrace`

**Errors:** `"Component not found: <label>"`

---

### Method 8: `getStateHistory(label: string, step: number, iteration?: number): StateHistoryReport`

Returns state0, state1, state2 for a component at a given step/iteration.

**Implementation:**
1. Call `_ensureRun()`.
2. Validate step is in range. Throw `"Step out of range: <step>"` if not.
3. If `iteration` is `undefined`, use the final iteration of the accepted step.
4. Get `ourIter = _ourSession!.steps[step].iterations[iteration]`. Throw `"Iteration out of range"` if not found.
5. Get `ngIter = _ngSessionAligned()?.steps[step]?.iterations[iteration]`.
6. Extract (all state1/state2 access via `elementStates`, not top-level iteration fields):
   - `state0`: `ourIter.elementStates.find(e => e.label.toUpperCase() === label.toUpperCase())?.slots ?? {}`
   - `state1`: `ourIter.elementStates.find(e => e.label.toUpperCase() === label.toUpperCase())?.state1Slots ?? {}`
   - `state2`: `ourIter.elementStates.find(e => e.label.toUpperCase() === label.toUpperCase())?.state2Slots ?? {}`
   - `ngspiceState0`: `ngIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel)?.slots ?? {}`
   - `ngspiceState1`: `ngIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel)?.state1Slots ?? {}`
   - `ngspiceState2`: `ngIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel)?.state2Slots ?? {}`

**Return:** `StateHistoryReport`

---

### Method 9: `getMatrixLabeled(step: number, iteration: number): LabeledMatrix`

Matrix entries with row/col labels from topology.

**Implementation:**
1. Call `_ensureRun()`.
2. Validate step and iteration. Throw on out-of-range.
3. Get `ourIter = _ourSession!.steps[step].iterations[iteration]`.
4. Get `ngIter = _ngSessionAligned()?.steps[step]?.iterations[iteration]`.
5. Build union of all `(row, col)` keys from both `ourIter.matrix` and `ngIter?.matrix`.
6. For each entry:
   - `rowLabel = _ourTopology.matrixRowLabels[row] ?? String(row)`
   - `colLabel = _ourTopology.matrixColLabels[col] ?? String(col)`
   - `ours`: value from our matrix (0 if absent)
   - `ngspice`: value from ngspice matrix (0 if absent)
   - `absDelta`, `withinTol`: use `_tol.iAbsTol` and `_tol.relTol`
7. Sort entries by `[row, col]` (row major).

**Return:** `LabeledMatrix`

---

### Method 10: `getRhsLabeled(step: number, iteration: number): LabeledRhs`

RHS vector entries with node labels.

**Implementation:**
1. Call `_ensureRun()`.
2. Validate step and iteration.
3. Get `ourIter` and `ngIter`.
4. For each index `i` from 0 to `matrixSize - 1`:
   - `label = _ourTopology.matrixRowLabels[i] ?? String(i)`
   - `ours = ourIter.preSolveRhs[i]` (use `preSolveRhs` — the RHS before solve, matching ngspice CKTload output)
   - `ngspice = ngIter?.preSolveRhs?.[i] ?? NaN`
   - `absDelta`, `withinTol`: use `_tol.iAbsTol` and `_tol.relTol`

**Return:** `LabeledRhs`

**Note:** `preSolveRhs` is used (not `rhs`/post-solve) because this is what ngspice captures in CKTload and what maps directly to the stamp contributions.

---

### Method 11: `compareMatrixAt(step: number, iteration: number, filter?: "all" | "mismatches"): MatrixComparison`

Side-by-side matrix comparison, labeled, with summary stats.

**Implementation:**
1. Get `LabeledMatrix` via `getMatrixLabeled(step, iteration)`.
2. If `filter === "mismatches"` (default): include only entries where `!withinTol`.
3. If `filter === "all"`: include all entries.
4. Compute `mismatchCount` and `maxAbsDelta` from the full (unfiltered) set.
5. Return `MatrixComparison`.

**Default `filter`:** `"mismatches"` (callers that want everything pass `"all"`).

---

### Method 12: `getIntegrationCoefficients(step: number): IntegrationCoefficientsReport`

ag0, ag1, method, order from both engines.

**Implementation:**
1. Call `_ensureRun()`.
2. Validate step. Throw `"Step out of range"` if not.
3. Get `coeffs = _ourSession!.steps[step].integrationCoefficients` (from Stream 1 field — no null check).
4. Build `ComparedValue` for ag0 and ag1 using tolerance 0 (exact numeric comparison).
5. `methodMatch = coeffs.ours.method === coeffs.ngspice.method && coeffs.ours.order === coeffs.ngspice.order`.

**Return:** `IntegrationCoefficientsReport`

---

### Method 13: `getLimitingComparison(label: string, step: number, iteration: number): LimitingComparisonReport`

Pre/post limit junction voltages from both engines.

**Implementation:**

`LimitingEvent` is Stream 1's per-engine type — each session stores its own events.
`getLimitingComparison` reads `limitingEvents` from both the our-side session and the
ng-side session separately, then merges them into `JunctionLimitingEntry` objects at
query time. No dual-field `LimitingEvent` type exists.

1. Call `_ensureRun()`.
2. Validate step and iteration.
3. Get `ourIter = _ourSession!.steps[step].iterations[iteration]`.
4. Get `ngIter = _ngSessionAligned()?.steps[step]?.iterations[iteration]`.
5. Filter `ourIter.limitingEvents` where `event.label.toUpperCase() === label.toUpperCase()`.
   These are our-engine events only — each has `vBefore`/`vAfter` from our limiting call.
6. Filter `ngIter?.limitingEvents` similarly (ngspice-engine events only).
7. Build union of all junction names from both sets.
8. For each junction name, find the matching event in our-side events and in ngspice-side
   events. Build `JunctionLimitingEntry`:
   - `ourPreLimit`: our event's `vBefore` (NaN if no our event for this junction).
   - `ourPostLimit`: our event's `vAfter` (NaN if no our event for this junction).
   - `ourDelta`: `ourPostLimit - ourPreLimit` (NaN if either is NaN).
   - `ngspicePreLimit`: ngspice event's `vBefore` (NaN if no ngspice event).
   - `ngspicePostLimit`: ngspice event's `vAfter` (NaN if no ngspice event).
   - `ngspiceDelta`: `ngspicePostLimit - ngspicePreLimit` (NaN if either is NaN).
   - `limitingDiff = ourDelta - ngspiceDelta` (NaN if either is NaN).
9. `noEvents = junctions.length === 0`.

**Return:** `LimitingComparisonReport`

---

### Method 14: `getConvergenceDetail(step: number, iteration: number): ConvergenceDetailReport`

Per-element convergence pass/fail from both engines.

**Implementation:**
1. Call `_ensureRun()`.
2. Validate step and iteration.
3. Get `ourIter` and `ngIter`.
4. Build element entries:
   - Collect all unique labels from `ourIter.elementStates` (all pool-backed elements).
   - For each label:
     - `deviceType`: from `_ourTopology.elements.find(e => e.label === label)?.type ?? "unknown"`
     - `ourConverged`: `!ourIter.convergenceFailedElements.includes(label)`
     - `ngspiceConverged`: `!ngIter?.ngspiceConvergenceFailedDevices.includes(label.toLowerCase()) ?? true`
     - `worstDelta`: find max `absDelta` from `_getComparisons().find(c => c.stepIndex === step && c.iterationIndex === iteration)?.stateDiffs.filter(d => d.elementLabel === label)` — or 0 if no diffs.
     - `agree = ourConverged === ngspiceConverged`
5. `disagreementCount`: count of entries where `!agree`.

**Return:** `ConvergenceDetailReport`

---

### Method 15: `toJSON(opts?: { includeAllSteps?: boolean; onlyDivergences?: boolean }): SessionReport`

Serialize session to JSON. All non-JSON-safe values converted per serialization rules.

**Implementation:**
1. Call `_ensureRun()`.
2. Build `summary` from `getSummary()` plus new fields from enhanced `getSummary()`.
3. Build `steps` array:
   - If `opts?.includeAllSteps !== true` (default): only include steps where any divergence exists (i.e., `!ComparisonResult.allWithinTol`).
   - If `opts?.includeAllSteps === true`: include all steps.
   - If `opts?.onlyDivergences === true`: include only steps with divergences (same as default behavior, kept explicit).
4. For each included step, call `getStepEnd(stepIndex)` and convert to JSON-safe form:
   - `NaN → null`, `Infinity → null` in all numeric fields.
   - `iterationCount.ours = ourStep.iterationCount`, `iterationCount.ngspice = ngStep?.iterationCount ?? null`.
5. `stepCount.ours = _ourSession!.steps.length`, `stepCount.ngspice = _ngSessionAligned()?.steps.length ?? 0`.

**JSON Safety:**
- All `NaN` values become `null`.
- All `Infinity` values become `null`.
- No `Map` or `Float64Array` in output.
- `ComparedValue` objects become inline objects with `null` for non-finite numerics.

**Return:** `SessionReport`

---

### Method 16: `static async create(opts: ComparisonSessionOptions): Promise<ComparisonSession>`

Factory replacing the two-step `new + init` pattern.

**Implementation:**
```typescript
static async create(opts: ComparisonSessionOptions): Promise<ComparisonSession> {
  const session = new ComparisonSession(opts);
  await session.init();
  return session;
}
```

No additional logic. This is a pure convenience wrapper.

---

### Method 17: `dispose(): void`

Clean up all held resources.

**Implementation:**
1. Set `_ourSession = null`.
2. Set `_ngSession = null`.
3. Set `_ngSessionReindexed = null`.
4. Set `_comparisons = null`.
5. Set `_nodeMap = []`.
6. If `_facade` exists and has a `dispose()` method, call it.
7. If `_coordinator` exists and has a `dispose()` method, call it.
8. No-op if called multiple times (idempotent).

---

## Enhanced Existing Methods on `ComparisonSession`

### `traceComponent(label, opts?)`

Add options:

```typescript
traceComponent(
  label: string,
  opts?: {
    slots?: string[];            // glob patterns — if provided, only matching slots in states
    stepsRange?: { from: number; to: number };
    onlyDivergences?: boolean;   // if true, only include iterations where ≥1 state diverges
    offset?: number;
    limit?: number;
  },
): ComponentTrace;
```

**Implementation changes:**
1. After collecting steps, filter by `opts?.stepsRange` (inclusive).
2. If `opts?.slots` provided, compile matcher and apply to `states` dict — only include matching keys.
3. If `opts?.onlyDivergences`, filter iterations: keep only those where `Object.values(states).some(cv => !cv.withinTol)`.
4. Apply `offset/limit` to the `steps` array (not iterations).
5. `deviceType` field on `ComponentTrace` is populated from `elInfo?.type ?? "unknown"` (uses capture fix).

---

### `traceNode(label, opts?)`

Add options:

```typescript
traceNode(
  label: string,
  opts?: {
    stepsRange?: { from: number; to: number };
    onlyDivergences?: boolean;   // if true, only iterations where voltage is out-of-tol
    offset?: number;
    limit?: number;
  },
): NodeTrace;
```

**Implementation changes:**
1. Filter steps by `opts?.stepsRange`.
2. If `opts?.onlyDivergences`, filter iterations to those where `!voltage.withinTol`.
3. Apply `offset/limit` to the `steps` array.

---

### `getStepEnd(stepIndex)` — `components` type change

```typescript
// Return type change: components field becomes Record<string, StepEndComponentEntry>
components: Record<string, StepEndComponentEntry>;
// where StepEndComponentEntry = { deviceType: string; slots: Record<string, ComparedValue> }
```

**Implementation changes:**
1. When building `components`, look up `deviceType` from `_ourTopology.elements.find(e => e.label === es.label)?.type ?? "unknown"`.
2. Wrap slot dict in `{ deviceType, slots: comp }`.

---

### `getIterations(stepIndex)` — `perElementConvergence` addition

```typescript
// Each IterationReport gains:
perElementConvergence: Array<{
  label: string;
  deviceType: string;
  converged: boolean;   // true if NOT in ourIter.convergenceFailedElements
  worstDelta: number;   // max absDelta across all state slots for this component at this iter
}>;
```

**Implementation:**
1. For each iteration report being built, scan `ourIter.elementStates`.
2. For each element state:
   - `label`: `es.label`
   - `deviceType`: from topology
   - `converged`: `!ourIter.convergenceFailedElements.includes(es.label)`
   - `worstDelta`: find max `absDelta` across all slots by comparing `es.slots[s]` to `ngEs?.slots[s] ?? NaN` using `_slotTolerance(s)`

---

### `getSummary()` — three new fields

```typescript
// Enhanced SessionSummary return includes:
perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }>;
integrationMethod: string | null;
stateHistoryIssues: { state1Mismatches: number; state2Mismatches: number };
```

**Implementation:**
1. `perDeviceType`: scan all `stateDiffs` from `_getComparisons()`. For each diff that is `!withinTol`, look up `deviceType` of `elementLabel` from topology, increment `divergenceCount`, update `worstAbsDelta`.
2. `integrationMethod`: find first step where `_ourSession!.steps[i].integrationCoefficients.ours.method !== "dc"` (i.e., first transient step). Return its `method`, or `null` if all DC.
3. `stateHistoryIssues`: for each step, compare `state1Slots` from our session vs ngspice; count steps where any slot exceeds tolerance. Same for `state2Slots`.

---

## Test Specification

**File:** `src/solver/analog/__tests__/harness/query-methods.test.ts`

All tests use `makeHWR()` and `makeRC()` helpers (copied from `harness-integration.test.ts`). No DLL or ngspice bridge required — tests run against self-comparison (our session compared to itself) to verify structure and pagination.

For tests requiring a `ComparisonSession`, construct a mock session:

```typescript
// Helper for tests: build a ComparisonSession-like object from captured data.
// Since ComparisonSession requires DLL for ngspice, tests drive internal
// state directly via captured sessions (both sides = ourSession = "self-comparison").
// The following test helpers are sufficient for all 40+ tests.
```

Tests that call `ComparisonSession` methods can use a minimal mock pattern:
- Set `_ourSession` to a captured session from `makeHWR()`.
- Set `_ngSessionReindexed` to the same captured session (self-comparison).
- Set `_ourTopology` from `captureTopology(circuit)`.
- Set `_analysis = "dcop"`.

Since `ComparisonSession` private fields cannot be set from tests directly, tests use the pattern: run `engine.dcOperatingPoint()` inside a real `MNAEngine`, capture via `createStepCaptureHook`, then construct a partial `ComparisonSession` by extracting and mocking the session. The spec allows tests to create a subclass `TestableComparisonSession extends ComparisonSession` that exposes a `setTestSession(ourSession, ngSession, topology)` method for test injection.

### Test Cases (minimum 40)

#### glob.ts — 7 tests

1. `compileSlotMatcher([]) → always false`
2. `compileSlotMatcher(["*"]) → always true`
3. `matchSlotPattern("Q_BE", ["Q_*"]) → true`
4. `matchSlotPattern("q_be", ["Q_*"]) → true (case-insensitive)`
5. `matchSlotPattern("VBE", ["Q_*"]) → false`
6. `matchSlotPattern("VBE", ["V?E"]) → true (? matches single char)`
7. `matchSlotPattern("GEQ", ["Q_*", "GEQ"]) → true (multiple patterns OR)`

#### format.ts — 6 tests

8. `formatComparedValue({ ours: 1.23e-3, ngspice: 1.24e-3, delta: -1e-5, absDelta: 1e-5, relDelta: 0.008, withinTol: true }, 4) → contains "ours=" and "PASS"`
9. `formatComparedValue with withinTol: false → contains "FAIL"`
10. `formatCV returns FormattedComparedValue with all string fields`
11. `formatComparedTable with 3 entries → sorted by absDelta descending, contains headers`
12. `mapToRecord(new Map([[1, "a"], [2, "b"]])) → { "1": "a", "2": "b" }`
13. `float64ToArray(new Float64Array([1.0, NaN, Infinity, -Infinity])) → [1.0, null, null, null]`

#### normalizeDeviceType — 4 tests

14. `normalizeDeviceType("NpnBJT") → "bjt"`
15. `normalizeDeviceType("NMOS") → "mosfet"`
16. `normalizeDeviceType("Capacitor") → "capacitor"`
17. `normalizeDeviceType("XYZUnknown") → "unknown"`

#### captureTopology fix — 1 test

18. After capture fix: `captureTopology(compiled, elementLabels)` returns elements where `type` is a non-empty string for all pool-backed elements.

#### `listComponents` — 3 tests

19. Returns one entry per element in topology.
20. Each `ComponentInfo` has non-empty `label` and `deviceType`.
21. `PaginationOpts`: `offset=1, limit=1` returns exactly one entry.

#### `listNodes` — 3 tests

22. Returns one entry per unique node in `nodeLabels`.
23. `NodeInfo.ourIndex` matches the key in `nodeLabels`.
24. `connectedComponents` is non-empty for nodes connected to elements.

#### `getComponentsByType` — 3 tests

25. Returns correct labels for type `"diode"` in HWR circuit.
26. Returns empty array for nonexistent type `"scr"`.
27. Case-insensitive: `getComponentsByType("BJT")` matches same as `"bjt"`.

#### `getDivergences` (self-comparison → zero divergences) — 4 tests

28. Self-comparison: `getDivergences()` returns `totalCount: 0` and empty `entries`.
29. `DivergenceReport.worstByCategory` has all null values when no divergences.
30. Default `limit` is 100: inject 200 artificial divergences, verify `entries.length === 100`.
31. `opts.step` filter: only returns divergences from that step.

#### `getStepEndRange` — 2 tests

32. `getStepEndRange(0, 0)` returns exactly 1 element matching `getStepEnd(0)`.
33. Out-of-range: `getStepEndRange(100, 200)` returns empty array.

#### `traceComponentSlot` — 3 tests

34. Returns `SlotTrace` with correct `label` and `slotName`.
35. `totalSteps` equals number of simulation steps captured.
36. Nonexistent component throws `"Component not found: ..."`.

#### `getStateHistory` — 3 tests

37. Returns `StateHistoryReport` with all six state objects.
38. `state0` matches `elementStates` from the iteration.
39. Out-of-range step throws `"Step out of range: ..."`.

#### `getMatrixLabeled` / `getRhsLabeled` / `compareMatrixAt` — 4 tests

40. `getMatrixLabeled` entries have non-empty `rowLabel` and `colLabel`.
41. Self-comparison: all `withinTol: true`, `absDelta: 0`.
42. `compareMatrixAt` with filter `"all"` returns more entries than `"mismatches"` (when no mismatches, both return same count).
43. `getRhsLabeled` entries count equals `matrixSize`.

#### `getIntegrationCoefficients` — 2 tests

44. Returns `IntegrationCoefficientsReport` with both `ours` and `ngspice` fields.
45. Out-of-range step throws `"Step out of range"`.

#### `getLimitingComparison` — 2 tests

46. Nonexistent label with no limiting events returns `noEvents: true, junctions: []`.
47. Nonexistent label does not throw — returns empty report.

#### `getConvergenceDetail` — 2 tests

48. Self-comparison with converged circuit: all elements have `ourConverged: true`.
49. `disagreementCount` is 0 when both engines agree.

#### `toJSON` — 3 tests

50. `toJSON()` returns an object serializable by `JSON.stringify` without error.
51. No `Map`, `Float64Array`, `NaN`, or `Infinity` in `JSON.stringify(session.toJSON())`.
52. `opts.includeAllSteps: true` includes all step entries; default includes none for self-comparison (no divergences).

#### Enhanced `traceComponent` / `traceNode` — 2 tests

53. `traceComponent("D1", { slots: ["VD"] })` returns only the `VD` slot in states.
54. `traceNode(label, { onlyDivergences: true })` returns empty iterations in self-comparison (none diverge).

#### `static create` — 1 test

55. `ComparisonSession.create(opts)` is equivalent to `new ComparisonSession(opts); await session.init()`. (Test by verifying `listComponents()` works without calling `init()` manually.)

#### `dispose` — 1 test

56. After `dispose()`, `ourSession` and `ngspiceSession` are `null`. `dispose()` is idempotent (call twice, no error).

#### Edge cases — 3 tests

57. `getComponentSlots("Q1", ["*"], { step: 0 })` returns `ComponentSlotsSnapshot` when step provided.
58. `getComponentSlots("D1", ["Q_*"])` returns `ComponentSlotsTrace` with only `Q_*`-matching slots.
59. `getComponentSlots("NONEXISTENT", ["*"])` throws `"Component not found"`.

---

## Module File List

New files created by Stream 3:

| File | Purpose |
|------|---------|
| `src/solver/analog/__tests__/harness/glob.ts` | Glob pattern matching utilities |
| `src/solver/analog/__tests__/harness/format.ts` | Formatting and serialization utilities |
| `src/solver/analog/__tests__/harness/query-methods.test.ts` | Test file (≥40 tests) |

Modified files:

| File | Changes |
|------|---------|
| `src/solver/analog/__tests__/harness/types.ts` | All new type definitions; enhanced existing interfaces |
| `src/solver/analog/__tests__/harness/device-mappings.ts` | Add `normalizeDeviceType()` |
| `src/solver/analog/__tests__/harness/capture.ts` | Fix `captureTopology()` to populate `type` field |
| `src/solver/analog/__tests__/harness/comparison-session.ts` | All 17 new methods + 5 enhanced methods |

---

## Dependency Graph

```
glob.ts          ←  comparison-session.ts (getComponentSlots, traceComponent)
format.ts        ←  comparison-session.ts (toJSON), Stream 2 MCP tools
device-mappings.ts (normalizeDeviceType)
  ←  capture.ts (captureTopology fix)
  ←  comparison-session.ts (getStepEnd, listComponents, getConvergenceDetail)
types.ts (new types)
  ←  comparison-session.ts (return types)
  ←  Stream 2 MCP tools (parameter types)
```

Stream 2 wraps every `ComparisonSession` method as an MCP tool. Every return type defined above must be directly JSON-serializable (no `.toJSON()` override needed on return values — they are plain objects by construction).

---

## Verification Checklist (for Stream 2 / Stream 3 verifier)

- [ ] All 17 new methods exist on `ComparisonSession`
- [ ] All 5 enhanced methods have new optional parameters (backward-compatible: existing callers with no opts still work)
- [ ] `StepEndReport.components` is `Record<string, StepEndComponentEntry>` (not `Record<string, Record<string, ComparedValue>>`)
- [ ] `IterationReport` has `perElementConvergence` array
- [ ] `SessionSummary` has `perDeviceType`, `integrationMethod`, `stateHistoryIssues`
- [ ] `glob.ts` exports `compileSlotMatcher` and `matchSlotPattern`
- [ ] `format.ts` exports `formatComparedValue`, `formatCV`, `formatComparedTable`, `mapToRecord`, `float64ToArray`
- [ ] `normalizeDeviceType` exported from `device-mappings.ts`
- [ ] `captureTopology` populates `type` on all elements
- [ ] `ComparisonSession.create` is a static async factory
- [ ] `dispose()` nulls all sessions and is idempotent
- [ ] `toJSON()` output passes `JSON.parse(JSON.stringify(output))` without error
- [ ] All 59 specified test cases pass
- [ ] No TypeScript diagnostics errors in modified files
