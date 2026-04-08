# Stream 2 Spec: MCP Tool Layer for the ngspice Comparison Harness

## 1. Overview

Stream 2 wraps the `ComparisonSession` comparison harness (Stream 1) behind an MCP tool
interface. Agents load a session, run an analysis, and query results through typed tool calls
that return labeled, paginated JSON. No raw typed arrays, no Maps, no UUIDs, no index-only
references leak into tool output.

### Design Goals

- **Session persistence.** A `harness_start` call creates a session keyed by an opaque handle
  (`h0`, `h1`, …). All subsequent calls reference that handle. Sessions live until
  `harness_dispose` or process exit.
- **Context-friendly sizing.** Every result collection is paginated. Defaults are chosen so
  a single tool response fits comfortably in an LLM context window.
- **Labels everywhere.** Node indices are resolved to canonical labels (`Q1:C`). Matrix
  positions are labeled (`G[Q1:B, Q1:C]`). Slot names are verbatim (`Q_BE`, `CCAP_BC`).
- **Queryable surface for every Stream 1 field.** If Stream 1 adds a field to any capture
  type, `harness_query` must expose a path to reach it. The query routing section (§4)
  specifies how each query mode maps to `ComparisonSession` methods.
- **Formatted numbers everywhere.** Every raw numeric value is accompanied by a `display`
  string in engineering notation (`1.234p`, `3.3m`, `12.0k`).

### Relationship to Other Streams

| Stream | Deliverable | Dependency |
|--------|-------------|------------|
| Stream 1 | `ComparisonSession` and capture types | Required — Stream 2 wraps it |
| Stream 2 | MCP tool layer (this spec) | Depends on Stream 1 |
| Stream 3 | ngspice FFI bridge + instrumentation callbacks | Required by Stream 1 |

Stream 2 can be stubbed and unit-tested with a mock `ComparisonSession` before Streams 1
and 3 are complete. All tool handler logic must tolerate a null/empty `ComparisonSession`
gracefully (return helpful errors, not crashes).

---

## 2. Tool Definitions

Each tool is defined with: name, title, description, Zod input schema, output shape, and
error cases.

---

### 2.1 `harness_start`

**Title:** Start Comparison Session

**Description:** Load a `.dts` circuit file and a `.cir` SPICE netlist, initialize both
engines, and return a handle for subsequent tool calls. The session captures topology
information immediately on init. Analysis is deferred until `harness_run`.

#### Input Schema (Zod)

```typescript
z.object({
  dtsPath:      z.string().describe("Absolute path to the .dts circuit file"),
  cirPath:      z.string().optional().describe(
    "Absolute path to the .cir SPICE netlist. " +
    "Required unless autoGenerate is true."
  ),
  autoGenerate: z.boolean().optional().describe(
    "When true, derive the .cir path by replacing the .dts extension with .cir " +
    "and looking in the same directory. Ignored if cirPath is provided."
  ),
  dllPath:      z.string().optional().describe(
    "Absolute path to the ngspice shared library (spice.dll / libngspice.so). " +
    "Defaults to NGSPICE_DLL_PATH env var, then the standard build location."
  ),
  tolerance:    z.object({
    vAbsTol: z.number().positive().optional().describe("Voltage absolute tolerance (V). Default: 1e-6"),
    iAbsTol: z.number().positive().optional().describe("Current absolute tolerance (A). Default: 1e-12"),
    relTol:  z.number().positive().optional().describe("Relative tolerance. Default: 1e-3"),
    qAbsTol: z.number().positive().optional().describe("Charge/capacitance tolerance (C/F). Default: 1e-14"),
  }).optional().describe("Tolerance overrides. Omit to use SPICE3 defaults."),
  maxOurSteps: z.number().int().min(1).optional().describe(
    "Maximum timestep captures from our engine per transient run. Default: 5000."
  ),
})
```

#### Output Shape

```typescript
interface HarnessStartOutput {
  handle: string;             // "h0", "h1", etc.
  status: "ready";
  dtsPath: string;
  cirPath: string;
  topology: {
    matrixSize: number;
    nodeCount: number;
    branchCount: number;
    elementCount: number;
    components: ComponentInfo[];
    nodes: NodeInfo[];
  };
}

interface ComponentInfo {
  label: string;              // "Q1", "R3", "C2"
  type: string;               // "bjt", "resistor", "capacitor", etc.
  isNonlinear: boolean;
  isReactive: boolean;
  pins: string[];             // canonical node labels for each pin: ["Q1:B", "Q1:C", "Q1:E"]
  slots: string[];            // state slot names: ["Q_BE", "Q_BC", "CCAP_BC", ...]
}

interface NodeInfo {
  label: string;              // "Q1:C", "R1:A", "gnd"
  index: number;              // MNA row index (0 = ground)
  connectedComponents: string[];  // component labels touching this node
}
```

#### Error Cases

| Condition | Message |
|-----------|---------|
| `dtsPath` not found | `harness_start: file not found: <path>` |
| `cirPath` not found and `autoGenerate` false | `harness_start: cirPath required or set autoGenerate: true` |
| Auto-generated `.cir` not found | `harness_start: auto-generated cir path not found: <path>` |
| `dllPath` not found | `harness_start: ngspice DLL not found: <path>. Set NGSPICE_DLL_PATH or pass dllPath.` |
| Circuit compile fails | `harness_start: circuit compile failed: <reason>` |
| Handle exhaustion (>10 000 sessions) | `harness_start: too many active sessions, dispose unused handles first` |

#### Behavior Notes

- Calls `ComparisonSession.init()`. If `init()` throws, no handle is allocated.
- The `slots` array in `ComponentInfo` is derived from the element's `StateSchema`.
  For elements without a state pool, `slots` is `[]`.
- Ground node (index 0) is omitted from `nodes` — it is the reference and has no label.
- The `pins` array maps positionally to the element's `pinNodeIds` from the topology.
  Pins connected to ground are represented as `"gnd"`.

---

### 2.2 `harness_run`

**Title:** Run Analysis

**Description:** Execute the analysis on both engines. Runs once; subsequent calls with the
same handle replace the previous result. Cached results are cleared on re-run.

#### Input Schema (Zod)

```typescript
z.object({
  handle:   z.string().describe("Harness session handle from harness_start"),
  analysis: z.enum(["dcop", "tran"]).describe(
    "'dcop' for DC operating point. 'tran' for transient analysis."
  ),
  // Transient-only parameters (ignored for dcop):
  stopTime: z.number().positive().optional().describe(
    "Transient stop time in seconds (required for tran). E.g. 5e-3 for 5 ms."
  ),
  startTime: z.number().min(0).optional().describe(
    "Transient start time in seconds. Default: 0."
  ),
  maxStep: z.number().positive().optional().describe(
    "Maximum timestep in seconds. Default: stopTime / 100."
  ),
})
```

#### Output Shape

```typescript
interface HarnessRunOutput {
  handle: string;
  analysis: "dcop" | "tran";
  summary: RunSummary;
  errors: string[];           // non-fatal errors (e.g. ngspice warnings)
}

interface RunSummary {
  stepCount: ComparedValueJSON;
  convergence: {
    ours: ConvergenceStats;
    ngspice: ConvergenceStats;
  };
  firstDivergence: FirstDivergenceJSON | null;
  totals: {
    compared: number;
    passed: number;
    failed: number;
  };
  // Transient only:
  timeRange?: {
    ours: { start: FormattedNumber; end: FormattedNumber };
    ngspice: { start: FormattedNumber; end: FormattedNumber };
  };
}

interface ConvergenceStats {
  totalSteps: number;
  convergedSteps: number;
  failedSteps: number;
  avgIterations: FormattedNumber;
  maxIterations: number;
  worstStep: number;          // step index with most iterations, -1 if no data
}

interface FirstDivergenceJSON {
  stepIndex: number;
  iterationIndex: number;
  simTime: FormattedNumber;
  worstLabel: string;         // canonical node/slot label, e.g. "Q1:C"
  absDelta: FormattedNumber;
}
```

#### Error Cases

| Condition | Message |
|-----------|---------|
| Unknown handle | `harness_run: unknown handle "<h>". Call harness_start first.` |
| `analysis: "tran"` without `stopTime` | `harness_run: stopTime is required for tran analysis` |
| `stopTime <= 0` | `harness_run: stopTime must be positive` |
| Our engine throws during run | `harness_run: our engine failed: <reason>` — still returns partial results |
| ngspice fails | Non-fatal: appended to `errors[]`, ngspice data treated as absent |

#### Behavior Notes

- For `dcop`, calls `ComparisonSession.runDcOp()`.
- For `tran`, calls `ComparisonSession.runTransient(startTime ?? 0, stopTime, maxStep)`.
- After the run completes, immediately calls `ComparisonSession.getSummary()` and
  formats the result for output.
- A re-run clears `_comparisons` via the session (already handled by `ComparisonSession`).
- `errors` is populated from `ComparisonSession.errors`.

---

### 2.3 `harness_query`

**Title:** Query Harness Data

**Description:** The primary data-extraction tool. Dispatches to the appropriate
`ComparisonSession` method based on the presence and combination of input fields. All
result collections are paginated with `offset`/`limit`. The `filter` parameter controls
whether all data or only divergences are returned.

#### Input Schema (Zod)

```typescript
z.object({
  handle: z.string().describe("Harness session handle"),

  // --- Query mode selectors (at most one primary mode active at a time) ---
  component:    z.string().optional().describe(
    "Component label to query (e.g. 'Q1'). Case-insensitive."
  ),
  node:         z.string().optional().describe(
    "Node label to trace (e.g. 'Q1:C'). Case-insensitive."
  ),
  step:         z.number().int().min(0).optional().describe(
    "Step index to inspect. Use with iterations/integrationCoefficients/convergence."
  ),
  deviceType:   z.string().optional().describe(
    "Filter by device type (e.g. 'bjt', 'diode', 'capacitor'). " +
    "Returns step-end data for all components of that type."
  ),
  type:         z.literal("summary").optional().describe(
    "Return session summary (same as harness_run output summary)."
  ),

  // --- Sub-mode modifiers ---
  slots:        z.array(z.string()).optional().describe(
    "Glob patterns for state slot names (e.g. ['Q_*', 'CCAP_*']). " +
    "Applied server-side. Omit for all slots."
  ),
  iterations:   z.boolean().optional().describe(
    "When true and step is set, return per-iteration data for that step."
  ),
  stateHistory: z.boolean().optional().describe(
    "When true, return state history for the component+step combination."
  ),
  integrationCoefficients: z.boolean().optional().describe(
    "When true and step is set, return integration method coefficients for that step " +
    "(requires Stream 3 extended callback support)."
  ),
  limiting:     z.boolean().optional().describe(
    "When true with component+step+iteration, return voltage/current limiting data."
  ),
  convergence:  z.boolean().optional().describe(
    "When true with step+iteration, return per-element convergence flags."
  ),

  // --- Filters and pagination ---
  filter:       z.enum(["all", "divergences", "worst"]).optional().describe(
    "'all' returns everything. 'divergences' returns only out-of-tolerance entries. " +
    "'worst' returns top-N entries by absDelta. Default: 'all'."
  ),
  worstN:       z.number().int().min(1).optional().describe(
    "When filter='worst', the number of entries to return. Default: 10."
  ),
  stepRange:    z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional().describe(
    "Inclusive [from, to] step index range. Applied before offset/limit."
  ),
  timeRange:    z.tuple([z.number(), z.number()]).optional().describe(
    "Inclusive [from, to] simulation time range in seconds. Applied before offset/limit."
  ),
  iteration:    z.number().int().min(0).optional().describe(
    "Specific NR iteration index within a step (0-based). " +
    "Use with step+limiting or step+convergence."
  ),
  offset:       z.number().int().min(0).optional().describe(
    "Result page offset. Default: 0."
  ),
  limit:        z.number().int().min(1).optional().describe(
    "Maximum entries to return. Default: 50 for traces, 100 for divergence lists."
  ),
})
```

#### Output Shape

The output schema depends on the active query mode. Every response includes a `queryMode`
discriminant and a `total` count (before pagination) so the agent can page through results.

```typescript
interface HarnessQueryOutput {
  handle: string;
  queryMode: QueryMode;
  total: number;              // total entries before pagination
  offset: number;
  limit: number;
  // One of the following is populated based on queryMode:
  summary?: RunSummary;
  componentTrace?: ComponentTraceJSON;
  nodeTrace?: NodeTraceJSON;
  stepEnd?: StepEndJSON;
  iterationData?: IterationDataJSON[];
  divergences?: DivergenceEntryJSON[];
  deviceTypeData?: DeviceTypeDataJSON;
  integrationCoefficients?: IntegrationCoefficientsJSON;
  limitingData?: LimitingDataJSON;
  convergenceData?: ConvergenceDataJSON[];
}

type QueryMode =
  | "summary"
  | "component-trace"
  | "component-step-end"
  | "node-trace"
  | "step-end"
  | "step-iterations"
  | "step-state-history"
  | "divergences"
  | "component-divergences"
  | "device-type"
  | "integration-coefficients"
  | "limiting"
  | "per-element-convergence";
```

#### Component Trace (`component` only)

Maps to `ComparisonSession.traceComponent(label)`. Returns a paginated view of steps.

```typescript
interface ComponentTraceJSON {
  label: string;
  deviceType: string;
  steps: ComponentStepJSON[];   // paginated slice
}

interface ComponentStepJSON {
  stepIndex: number;
  simTime: FormattedNumber;
  iterations: ComponentIterationJSON[];
}

interface ComponentIterationJSON {
  iteration: number;
  states: Record<string, ComparedValueJSON>;   // slot name -> compared value
  pinVoltages: Record<string, ComparedValueJSON>; // "Q1:C" -> compared value
}
```

Slot filtering via `slots` glob patterns is applied before pagination. Only slots whose
names match at least one pattern are included.

#### Node Trace (`node` only)

Maps to `ComparisonSession.traceNode(label)`.

```typescript
interface NodeTraceJSON {
  label: string;
  ourIndex: number;
  ngspiceIndex: number;
  steps: NodeStepJSON[];        // paginated slice
}

interface NodeStepJSON {
  stepIndex: number;
  simTime: FormattedNumber;
  iterations: Array<{
    iteration: number;
    voltage: ComparedValueJSON;
  }>;
}
```

#### Step End (`step` only, no modifiers)

Maps to `ComparisonSession.getStepEnd(step)`.

```typescript
interface StepEndJSON {
  stepIndex: number;
  simTime: ComparedValueJSON;
  dt: ComparedValueJSON;
  converged: { ours: boolean; ngspice: boolean };
  iterationCount: ComparedValueJSON;
  nodes: Record<string, ComparedValueJSON>;
  branches: Record<string, ComparedValueJSON>;
  components: Record<string, Record<string, ComparedValueJSON>>;
}
```

`filter: "divergences"` removes all `ComparedValueJSON` entries where `withinTol` is true.

#### Step Iterations (`step` + `iterations: true`)

Maps to `ComparisonSession.getIterations(step)`. Returns one entry per NR iteration.

```typescript
interface IterationDataJSON {
  stepIndex: number;
  iteration: number;
  simTime: FormattedNumber;
  noncon: ComparedValueJSON;
  nodes: Record<string, ComparedValueJSON>;
  /** Previous-iteration node voltages keyed by node label. Same keys as `nodes`. */
  prevNodes: Record<string, ComparedValueJSON>;
  rhs: Record<string, ComparedValueJSON>;
  matrixDiffs: MatrixDiffJSON[];
  components: Record<string, Record<string, ComparedValueJSON>>;
}

interface MatrixDiffJSON {
  rowLabel: string;       // canonical label for the MNA row: "Q1:B"
  colLabel: string;       // canonical label for the MNA column: "Q1:C"
  ours: FormattedNumber;
  ngspice: FormattedNumber;
  absDelta: FormattedNumber;
}
```

#### Divergences (`filter: "divergences"`, no component/node)

Aggregates all out-of-tolerance entries across all steps and iterations.

```typescript
interface DivergenceEntryJSON {
  stepIndex: number;
  iterationIndex: number;
  simTime: FormattedNumber;
  type: "node" | "rhs" | "matrix" | "state";
  label: string;          // "Q1:C" for node, "G[Q1:B,Q1:C]" for matrix, "Q1.Q_BE" for state
  ours: FormattedNumber;
  ngspice: FormattedNumber;
  absDelta: FormattedNumber;
  relDelta: FormattedNumber;
}
```

When `filter: "worst"`, the `worstN` (default 10) entries with the largest `absDelta` are
returned, sorted descending by `absDelta`.

#### Component Divergences (`component` + `filter: "divergences"`)

Same shape as the divergences list but pre-filtered to the named component's slots and
pin-node voltages.

#### State History (`component` + `step` + `stateHistory: true`)

Returns the state slot values for the named component across all NR iterations of the
named step. Maps to the `componentTrace.steps[step].iterations` view, filtered to only
state slots.

```typescript
interface StateHistoryJSON {
  component: string;
  stepIndex: number;
  simTime: FormattedNumber;
  slots: string[];            // slot names (after glob filtering)
  iterations: Array<{
    iteration: number;
    states: Record<string, ComparedValueJSON>;
  }>;
}
```

#### Device Type (`deviceType`)

Returns step-end component data for every component of the named type. Merges results
across steps (paginated by step).

```typescript
interface DeviceTypeDataJSON {
  deviceType: string;
  components: string[];       // labels of matching components
  steps: Array<{
    stepIndex: number;
    simTime: FormattedNumber;
    components: Record<string, Record<string, ComparedValueJSON>>;
  }>;
}
```

#### Integration Coefficients (`step` + `integrationCoefficients: true`)

Returns the integration method coefficients captured for the named step. All Stream 1 data
fields are mandatory and always populated after `harness_run` completes.

```typescript
interface IntegrationCoefficientsJSON {
  stepIndex: number;
  ours: {
    ag0: FormattedNumber;
    ag1: FormattedNumber;
    method: string;     // "backwardEuler", "trapezoidal", or "gear2"
    order: number;
  };
  ngspice: {
    ag0: FormattedNumber;
    ag1: FormattedNumber;
    method: string;
    order: number;
  };
  cktMode: number;            // raw CKTmode flags bitmask from ngspice session
  ag0Compared: ComparedValueJSON;
  ag1Compared: ComparedValueJSON;
  methodMatch: boolean;
}
```

#### Limiting (`component` + `step` + `iteration` + `limiting: true`)

Returns voltage/current limiting data applied during the named NR iteration for the named
component. All Stream 1 data fields are mandatory and always populated after `harness_run`
completes.

```typescript
interface LimitingDataJSON {
  component: string;
  stepIndex: number;
  iteration: number;
  /** One entry per junction that had a limiting event in either engine. */
  junctions: Array<{
    junction: string;
    ourPreLimit: FormattedNumber;
    ourPostLimit: FormattedNumber;
    ourDelta: FormattedNumber;
    ngspicePreLimit: FormattedNumber;
    ngspicePostLimit: FormattedNumber;
    ngspiceDelta: FormattedNumber;
    limitingDiff: FormattedNumber;
  }>;
  /** True if no limiting events found for this component at this iteration. */
  noEvents: boolean;
}
```

#### Per-Element Convergence (`step` + `iteration` + `convergence: true`)

Returns the per-element convergence test outcome for the named NR iteration. Maps to
`IterationSnapshot.elemConverged` per element.

```typescript
interface ConvergenceDataJSON {
  label: string;              // component label
  deviceType: string;
  converged: boolean;
  noncon: number;             // element's contribution to the noncon counter
  worstSlot?: string;         // slot name with largest delta, if available
  worstDelta?: FormattedNumber;
}
```

#### Error Cases

| Condition | Message |
|-----------|---------|
| Unknown handle | `harness_query: unknown handle "<h>"` |
| No analysis run yet | `harness_query: run harness_run first` |
| `step` out of range | `harness_query: step <n> out of range [0, <max>]` |
| Unknown component | `harness_query: component "<X>" not found. Did you mean: <closest>?` |
| Unknown node | `harness_query: node "<X>" not found. Known nodes: <first 10>` |
| Unknown deviceType | `harness_query: no components of type "<X>". Available types: <list>` |
| Conflicting modifiers | `harness_query: cannot combine <A> and <B> query modes` |
| No primary mode | `harness_query: specify one of: component, node, step, deviceType, type, or filter` |

---

### 2.4 `harness_describe`

**Title:** Describe Circuit Topology

**Description:** Return full circuit topology metadata for the session — components with
their pin assignments and slot names, and nodes with connectivity. Does not require
`harness_run` to be called first.

#### Input Schema (Zod)

```typescript
z.object({
  handle: z.string().describe("Harness session handle"),
})
```

#### Output Shape

```typescript
interface HarnessDescribeOutput {
  handle: string;
  matrixSize: number;
  nodeCount: number;
  branchCount: number;
  elementCount: number;
  components: ComponentInfoDetailed[];
  nodes: NodeInfoDetailed[];
  nodeMapping: NodeMappingJSON[];   // our ↔ ngspice index mappings (after harness_run)
}

interface ComponentInfoDetailed {
  label: string;
  index: number;              // element index in compiled.elements[]
  type: string;
  isNonlinear: boolean;
  isReactive: boolean;
  pins: Array<{
    label: string;            // "Q1:C"
    nodeIndex: number;        // MNA row index, 0 for ground
  }>;
  slots: string[];
}

interface NodeInfoDetailed {
  label: string;
  index: number;
  connectedComponents: Array<{
    label: string;
    pinLabel: string;
  }>;
}

interface NodeMappingJSON {
  ourIndex: number;
  ngspiceIndex: number;
  label: string;
  ngspiceName: string;        // e.g. "q1_c", "r1_1"
}
```

#### Error Cases

| Condition | Message |
|-----------|---------|
| Unknown handle | `harness_describe: unknown handle "<h>"` |

#### Behavior Notes

- `nodeMapping` is populated only after `harness_run` is called. Before that, it is `[]`.
- Ground is excluded from `nodes` (index 0 is the reference).
- The `index` in `ComponentInfoDetailed` matches the `elementIndex` used in
  `ElementStateSnapshot`, allowing agents to cross-reference describe output with query
  output.

---

### 2.5 `harness_compare_matrix`

**Title:** Compare MNA Matrix

**Description:** Return a labeled comparison of MNA matrix entries for a specific step and
NR iteration. Each entry contains the row and column labels (derived from topology) and
both engine values. Supports filtering to mismatches only.

#### Input Schema (Zod)

```typescript
z.object({
  handle:    z.string().describe("Harness session handle"),
  step:      z.number().int().min(0).describe("Step index"),
  iteration: z.number().int().min(0).describe("NR iteration index within the step"),
  filter:    z.enum(["all", "mismatches"]).optional().describe(
    "'all' returns every captured matrix entry. " +
    "'mismatches' returns only entries where |ours - ngspice| exceeds tolerance. Default: 'mismatches'."
  ),
  offset:    z.number().int().min(0).optional().describe("Pagination offset. Default: 0."),
  limit:     z.number().int().min(1).optional().describe(
    "Maximum entries to return. Default: 100."
  ),
})
```

#### Output Shape

```typescript
interface HarnessCompareMatrixOutput {
  handle: string;
  step: number;
  iteration: number;
  filter: "all" | "mismatches";
  total: number;
  offset: number;
  limit: number;
  entries: MatrixEntryComparedJSON[];
}

interface MatrixEntryComparedJSON {
  rowLabel: string;       // "Q1:B" — canonical label for this MNA row
  colLabel: string;       // "Q1:C" — canonical label for this MNA column
  rowIndex: number;       // raw row index (for cross-referencing)
  colIndex: number;       // raw col index
  ours: FormattedNumber;
  ngspice: FormattedNumber;
  delta: FormattedNumber;
  absDelta: FormattedNumber;
  withinTol: boolean;
}
```

#### Error Cases

| Condition | Message |
|-----------|---------|
| Unknown handle | `harness_compare_matrix: unknown handle "<h>"` |
| No analysis run | `harness_compare_matrix: run harness_run first` |
| `step` out of range | `harness_compare_matrix: step <n> out of range [0, <max>]` |
| `iteration` out of range | `harness_compare_matrix: iteration <n> out of range [0, <max>] at step <s>` |

#### Behavior Notes

- Row/column labels are resolved using the `nodeLabels` map from `TopologySnapshot`. A
  row with no label entry uses the format `row<N>`.
- The `IterationReport.matrixDiffs` from `ComparisonSession.getIterations()` only contains
  entries where `ngspice` data is present. When ngspice data is absent, the matrix is
  presented as ours-only with `ngspice: { raw: null, display: "—" }`.
- When `filter: "all"`, entries from both engines that are zero on both sides are included
  only if they appear in the captured non-zero list. The matrix is sparse — only stamped
  entries appear.

---

### 2.6 `harness_export`

**Title:** Export Session Report

**Description:** Serialize the full session (or a filtered subset) to a self-contained JSON
object. Useful for persisting results for offline analysis or sharing between agents.

#### Input Schema (Zod)

```typescript
z.object({
  handle:           z.string().describe("Harness session handle"),
  includeAllSteps:  z.boolean().optional().describe(
    "When true, include all step data. When false (default), include only " +
    "the summary and divergent steps."
  ),
  onlyDivergences:  z.boolean().optional().describe(
    "When true, only export steps and iterations that contain at least one " +
    "out-of-tolerance comparison. Overrides includeAllSteps."
  ),
  path:             z.string().optional().describe(
    "If provided, write the JSON to this file path in addition to returning it inline. " +
    "Useful for large exports that exceed inline response size."
  ),
})
```

#### Output Shape

```typescript
interface HarnessExportOutput {
  handle: string;
  exportedAt: string;         // ISO 8601 timestamp
  dtsPath: string;
  cirPath: string;
  analysis: "dcop" | "tran" | null;
  summary: RunSummary | null;
  topology: {
    components: ComponentInfoDetailed[];
    nodes: NodeInfoDetailed[];
  };
  steps: ExportedStepJSON[];  // filtered according to options
  writtenTo?: string;         // populated if path was provided
  sizeBytes: number;          // JSON byte size of the steps array
}

interface ExportedStepJSON {
  stepIndex: number;
  simTime: number;
  dt: number;
  converged: boolean;
  iterationCount: number;
  divergences: DivergenceEntryJSON[];
  // Included when includeAllSteps:
  iterations?: IterationDataJSON[];
}
```

#### Error Cases

| Condition | Message |
|-----------|---------|
| Unknown handle | `harness_export: unknown handle "<h>"` |
| No analysis run | `harness_export: run harness_run first before exporting` |
| File write failure | `harness_export: failed to write to <path>: <reason>` |

---

### 2.7 `harness_dispose`

**Title:** Dispose Harness Session

**Description:** Clean up a session and release all associated resources (FFI allocations,
captured data buffers, engine instances).

#### Input Schema (Zod)

```typescript
z.object({
  handle: z.string().describe("Harness session handle to dispose"),
})
```

#### Output Shape

```typescript
interface HarnessDisposeOutput {
  handle: string;
  success: true;
}
```

#### Error Cases

| Condition | Message |
|-----------|---------|
| Unknown handle | `harness_dispose: unknown handle "<h>". Already disposed?` |

#### Behavior Notes

- Calls `ComparisonSession.dispose()` (see §3).
- After disposal, the handle is removed from the map. Any subsequent call referencing the
  disposed handle returns the "unknown handle" error.
- It is safe to call `harness_dispose` on a session that never had `harness_run` called.

---

## 3. Handle Management

### `HarnessSessionState` Class

New file: `scripts/mcp/harness-session-state.ts`

```typescript
/**
 * HarnessSessionState — lifecycle manager for ComparisonSession instances.
 *
 * Parallel to SessionState in tool-helpers.ts but specialized for harness sessions.
 * Each session maps to one ComparisonSession instance and its metadata.
 */

import type { ComparisonSession } from "../../src/solver/analog/__tests__/harness/comparison-session.js";

export interface HarnessEntry {
  session: ComparisonSession;
  dtsPath: string;
  cirPath: string;
  createdAt: Date;
  lastRunAt: Date | null;
  analysis: "dcop" | "tran" | null;
}

export class HarnessSessionState {
  private readonly _sessions = new Map<string, HarnessEntry>();
  private _counter = 0;

  /**
   * Allocate a handle and store the session entry.
   * Returns the new handle string.
   */
  store(entry: HarnessEntry): string {
    const handle = `h${this._counter++}`;
    this._sessions.set(handle, entry);
    return handle;
  }

  /**
   * Retrieve a session entry by handle.
   * Throws a descriptive error if the handle is unknown.
   */
  get(handle: string, toolName: string): HarnessEntry {
    const entry = this._sessions.get(handle);
    if (!entry) {
      const known = [...this._sessions.keys()].join(", ") || "(none)";
      throw new Error(
        `${toolName}: unknown handle "${handle}". ` +
        `Active handles: ${known}. Call harness_start first.`,
      );
    }
    return entry;
  }

  /**
   * Dispose a session and remove it from the map.
   * Throws if the handle is unknown.
   */
  dispose(handle: string): void {
    const entry = this._sessions.get(handle);
    if (!entry) {
      throw new Error(
        `harness_dispose: unknown handle "${handle}". Already disposed?`,
      );
    }
    entry.session.dispose();
    this._sessions.delete(handle);
  }

  /** Number of active sessions. */
  get size(): number {
    return this._sessions.size;
  }

  /** All active handles. */
  handles(): string[] {
    return [...this._sessions.keys()];
  }
}
```

### `ComparisonSession.dispose()` — Required Addition to Stream 1

`ComparisonSession` does not currently have a `dispose()` method. Stream 2 requires it.
This method MUST be added to `ComparisonSession` as part of Stream 1 delivery (or as a
prerequisite to Stream 2 implementation).

```typescript
/**
 * Release all resources held by this session.
 *
 * After calling dispose():
 * - The facade and coordinator are invalidated.
 * - Captured step data (ourSession, ngSession) is nulled.
 * - Comparison cache is cleared.
 * - Any subsequent query method throws "disposed".
 *
 * The NgspiceBridge is already disposed at the end of runDcOp/runTransient —
 * it does not need to be re-disposed here.
 */
dispose(): void {
  if (this._disposed) return;
  this._disposed = true;

  // Invalidate engine resources
  if (this._facade) {
    this._facade.invalidate();
  }

  // Clear all capture data (allows GC of Float64Arrays)
  this._ourSession = null;
  this._ngSession = null;
  this._ngSessionReindexed = null;
  this._comparisons = null;
  this._nodeMap = [];
}

private _disposed = false;
```

The `_ensureRun()` guard must also check `_disposed`:

```typescript
private _ensureRun(): void {
  if (this._disposed) {
    throw new Error("ComparisonSession: session has been disposed");
  }
  if (!this._ourSession) {
    throw new Error("ComparisonSession: call runDcOp() or runTransient() first");
  }
}
```

---

## 4. Query Routing

`harness_query` dispatches to `ComparisonSession` methods based on the presence and
combination of input fields. The following decision table is exhaustive. Implementations
MUST follow this exact precedence.

| Priority | Active Fields | Query Mode | ComparisonSession Method |
|----------|--------------|------------|--------------------------|
| 1 | `type: "summary"` | `summary` | `getSummary()` |
| 2 | `component` + `step` + `iteration` + `limiting` | `limiting` | `getIterations(step)[iteration]` + limiting data |
| 3 | `component` + `step` + `iteration` + `convergence` | `per-element-convergence` | `getIterations(step)[iteration]` filtered to component |
| 4 | `step` + `iteration` + `convergence` | `per-element-convergence` | `getIterations(step)[iteration]` all elements |
| 5 | `component` + `step` + `stateHistory` | `step-state-history` | `getIterations(step)` filtered to component states |
| 6 | `step` + `integrationCoefficients` | `integration-coefficients` | `getStepEnd(step)` + extended fields |
| 7 | `step` + `iterations` | `step-iterations` | `getIterations(step)` |
| 8 | `component` + `step` (no modifiers) | `component-step-end` | `getStepEnd(step)` filtered to component |
| 9 | `component` + `filter: "divergences"` | `component-divergences` | `traceComponent(component)` filtered |
| 10 | `component` (no step, no filter) | `component-trace` | `traceComponent(component)` |
| 11 | `node` | `node-trace` | `traceNode(node)` |
| 12 | `step` (no modifiers) | `step-end` | `getStepEnd(step)` |
| 13 | `deviceType` | `device-type` | multiple `getStepEnd()` calls filtered |
| 14 | `filter: "divergences"` or `filter: "worst"` (no component) | `divergences` | all `ComparisonResult[]` scanned |
| 15 | (no primary mode) | error | — |

### Conflict Detection

If the input would match two or more rows at the same priority level, the tool returns:

```
harness_query: ambiguous query — cannot combine <field1> and <field2>
```

The following combinations are explicitly forbidden:
- `component` + `node` (choose one)
- `iterations` + `stateHistory` (choose one)
- `limiting` + `convergence` (choose one)
- `integrationCoefficients` + `iterations` (choose one)

### Range and Pagination Application Order

1. Apply `stepRange` (inclusive index filter).
2. Apply `timeRange` (filter steps whose `simTime` falls within the range).
3. Collect matching records.
4. Apply `filter` (all / divergences / worst).
5. Apply `slots` glob filter (for component/state queries).
6. Apply `offset` + `limit` (return the slice).
7. Set `total` to the count before step 6.

---

## 5. JSON Serialization

### `FormattedNumber`

All raw numeric values in tool output are wrapped in `FormattedNumber`:

```typescript
interface FormattedNumber {
  raw: number | null;   // null if the original value was NaN
  display: string;      // engineering notation string
}
```

**Engineering notation rules:**

| Magnitude | Suffix | Example |
|-----------|--------|---------|
| >= 1e12 | T | `1.234T` |
| >= 1e9 | G | `4.567G` |
| >= 1e6 | M | `2.345M` |
| >= 1e3 | k | `1.000k` |
| >= 1 | (none) | `3.300` |
| >= 1e-3 | m | `3.300m` |
| >= 1e-6 | u | `1.234u` |
| >= 1e-9 | n | `4.567n` |
| >= 1e-12 | p | `1.234p` |
| < 1e-12 | f | `0.001f` |
| 0 | (none) | `0.000` |
| NaN | — | `NaN` → `raw: null, display: "—"` |
| Infinity | — | `+Inf` or `−Inf` |

Significant digits: 4 (matching SPICE output precision). Always include sign for negative.

### `ComparedValueJSON`

```typescript
interface ComparedValueJSON {
  ours: FormattedNumber;
  ngspice: FormattedNumber;
  delta: FormattedNumber;         // ours.raw - ngspice.raw, null if either is null
  absDelta: FormattedNumber;
  relDelta: FormattedNumber;
  withinTol: boolean;
}
```

### `NaN → null`

Every `NaN` in the raw numeric space becomes `null` in the `raw` field of `FormattedNumber`
and `"—"` in the `display` field. This applies to:
- Node voltages when ngspice data is absent for that step.
- Slot values when the slot has no ngspice mapping.
- Delta values when either `ours` or `ngspice` is `null`.

### `Float64Array → labeled entries`

`IterationSnapshot.voltages`, `.prevVoltages`, `.preSolveRhs`, and `.matrix` are `Float64Array`
instances in memory. These MUST be converted to labeled records or arrays of labeled
objects before being placed in tool output. The conversion uses `TopologySnapshot.nodeLabels`
to map indices to labels. (`rhs` has been removed from `IterationSnapshot` — use `preSolveRhs`.)

```
voltages[i] → { label: nodeLabels.get(i+1) ?? "row<i>", value: FormattedNumber }
```

The ground node (index 0) is always omitted.

### `Map<K, V> → Record<string, V>`

All `Map` instances in `ComparisonSession` types are converted to plain `Record<string, V>`
objects in tool output. The key is always the string label.

### Matrix Position Labels

Matrix positions `(row, col)` are labeled as:

```
G[<rowLabel>, <colLabel>]
```

Where `<rowLabel>` and `<colLabel>` are resolved from `TopologySnapshot.nodeLabels`. If
no label exists for index `i`, use `row<i>` / `col<i>`.

In `DivergenceEntryJSON`, the `label` field for matrix entries uses the compact form:
```
G[Q1:B,Q1:C]
```

### State Slot Labels

In `DivergenceEntryJSON`, state slot labels use dot notation to distinguish them from
node labels:

```
Q1.Q_BE        (component Q1, slot Q_BE)
D1.ID          (component D1, slot ID)
```

In `ComponentTraceJSON` and `StepEndJSON`, component states are keyed by component label
at the outer level and slot name at the inner level, so no dot notation is needed.

---

## 6. Pagination and Size Limits

### Default Limits

| Query Mode | Default `limit` |
|------------|----------------|
| Component trace (steps) | 50 |
| Node trace (steps) | 50 |
| Step iterations | 100 |
| Divergence list | 100 |
| Matrix entries | 100 |
| Device type (steps) | 50 |
| State history (iterations) | 100 |

### Size Guard

Before returning any result, estimate the serialized JSON size. If the estimated size
exceeds 200 KB, automatically reduce the limit to fit and include a warning in the
response:

```
"sizeWarning": "Result was truncated to <N> entries to stay within 200 KB. Use offset to page."
```

The size estimate uses: `entryCount * avgEntrySize`, where `avgEntrySize` is calibrated
per query mode (matrix entries ≈ 200 bytes, trace steps ≈ 500 bytes, etc.).

### `total` Field

Every paginated response includes `total: number` — the count of matching entries
**before** applying `offset`/`limit`. This allows agents to detect that more pages exist
without making a second call.

### Iterating Large Results

An agent iterating a large trace should:
1. Call with no `offset`/`limit` to get `total`.
2. Page with `offset: 0, limit: 50`, then `offset: 50, limit: 50`, etc.
3. Stop when `offset + limit >= total`.

---

## 7. Error Handling

### Error Response Shape

All errors follow the `wrapTool` pattern from `tool-helpers.ts`:

```typescript
{
  content: [{ type: "text", text: "<toolName> error: <message>" }],
  isError: true
}
```

Tool handlers MUST use `wrapTool()` from `tool-helpers.ts`. Errors thrown inside the
handler are caught and formatted automatically.

### Error Codes and Messages

| Code | Category | Message Template |
|------|----------|-----------------|
| `UNKNOWN_HANDLE` | Session | `<tool>: unknown handle "<h>". Active handles: <list>. Call harness_start first.` |
| `NOT_RUN` | Session | `<tool>: analysis not run. Call harness_run with handle "<h>" first.` |
| `DISPOSED` | Session | `<tool>: session "<h>" has been disposed.` |
| `STEP_OOB` | Range | `<tool>: step <n> out of range [0, <max>]. Run has <max+1> steps.` |
| `ITER_OOB` | Range | `<tool>: iteration <n> out of range [0, <max>] at step <s>.` |
| `UNKNOWN_COMPONENT` | Query | `<tool>: component "<X>" not found. Did you mean: <closest1>, <closest2>?` |
| `UNKNOWN_NODE` | Query | `<tool>: node "<X>" not found. Known nodes (first 10): <list>.` |
| `UNKNOWN_DEVICE_TYPE` | Query | `<tool>: no components of type "<X>". Types present: <list>.` |
| `AMBIGUOUS_QUERY` | Query | `harness_query: ambiguous — cannot combine <A> and <B>.` |
| `NO_QUERY_MODE` | Query | `harness_query: no query mode selected. Provide: component, node, step, deviceType, or type.` |
| `MISSING_PARAM` | Input | `<tool>: <param> is required for <mode>.` |
| `FILE_NOT_FOUND` | I/O | `harness_start: file not found: <path>.` |
| `COMPILE_FAIL` | Engine | `harness_start: circuit compile failed: <reason>.` |

### "Did You Mean" for Components

Component name suggestions use Levenshtein distance. Return the top 2 closest matches
from `TopologySnapshot.elements[*].label`. Implementation in the tool handler:

```typescript
function suggestComponents(input: string, labels: string[]): string[] {
  const upper = input.toUpperCase();
  return labels
    .map(l => ({ l, d: levenshtein(upper, l.toUpperCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map(x => `"${x.l}"`);
}
```

---

## 8. Integration Points

### File: `scripts/mcp/harness-tools.ts`

New file. Contains `registerHarnessTools(server, harnessState)`.

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wrapTool } from "./tool-helpers.js";
import { HarnessSessionState } from "./harness-session-state.js";
import {
  ComparisonSession,
  type ComparisonSessionOptions,
} from "../../src/solver/analog/__tests__/harness/comparison-session.js";

export function registerHarnessTools(
  server: McpServer,
  harnessState: HarnessSessionState,
): void {
  server.registerTool("harness_start", { ... }, wrapTool(...));
  server.registerTool("harness_run",   { ... }, wrapTool(...));
  server.registerTool("harness_query", { ... }, wrapTool(...));
  server.registerTool("harness_describe", { ... }, wrapTool(...));
  server.registerTool("harness_compare_matrix", { ... }, wrapTool(...));
  server.registerTool("harness_export", { ... }, wrapTool(...));
  server.registerTool("harness_dispose", { ... }, wrapTool(...));
}
```

### File: `scripts/circuit-mcp-server.ts`

Add harness state and registration after the existing tool module registrations:

```typescript
// ADD these imports:
import { HarnessSessionState } from "./mcp/harness-session-state.js";
import { registerHarnessTools } from "./mcp/harness-tools.js";

// ADD after existing session declaration:
const harnessState = new HarnessSessionState();

// ADD after existing registerSimulationTools(...) call:
registerHarnessTools(server, harnessState);
```

The harness registration is unconditional — it is always present in the MCP server. When
the ngspice DLL is not installed, `harness_start` will fail with a descriptive error
rather than silently omitting the tools.

### Server Instructions Update

The MCP server `instructions` string in `circuit-mcp-server.ts` must be extended:

```typescript
instructions:
  "... existing instructions ... " +
  "To compare our engine against ngspice: use harness_start to create a session, " +
  "harness_run to execute analysis, then harness_query or harness_compare_matrix " +
  "to inspect results. harness_describe shows circuit topology. " +
  "harness_dispose releases resources when done.",
```

---

## 9. Dependencies on Streams 1 and 3

### Stream 1 Requirements

Stream 2 requires the following to be present in Stream 1 before implementation:

| Requirement | Where Used |
|-------------|------------|
| `ComparisonSession` class | All harness tools |
| `ComparisonSession.init()` | `harness_start` |
| `ComparisonSession.runDcOp()` | `harness_run` (dcop) |
| `ComparisonSession.runTransient()` | `harness_run` (tran) |
| `ComparisonSession.getStepEnd()` | `harness_query` step-end |
| `ComparisonSession.getIterations()` | `harness_query` step-iterations |
| `ComparisonSession.traceComponent()` | `harness_query` component-trace |
| `ComparisonSession.traceNode()` | `harness_query` node-trace |
| `ComparisonSession.getSummary()` | `harness_query` summary, `harness_run` |
| `ComparisonSession.dispose()` | `harness_dispose` — **must be added** |
| `TopologySnapshot.nodeLabels` Map | Label resolution throughout |
| `TopologySnapshot.elements[*].slots` | `harness_describe`, slot filtering |
| `ComparisonResult[]` from `compareSnapshots()` | Divergence aggregation |
| All types in `types.ts` | JSON serialization |

### Stream 1 Data Fields

All Stream 1 data fields are mandatory and always populated after `harness_run` completes.
The following query modes map directly to Stream 1 fields — they are always available and
never return partial or unavailable results:

| Query Mode | Stream 1 Field |
|------------|---------------|
| `integrationCoefficients` | `StepSnapshot.integrationCoefficients` (both `ours` and `ngspice` sub-objects) |
| `limiting` | `IterationSnapshot.limitingEvents` (our-side) + aligned ngspice session events |
| `step-state-history` | `ElementStateSnapshot.state1Slots`, `ElementStateSnapshot.state2Slots` |
| RHS queries | `IterationSnapshot.preSolveRhs` |

### Consuming All Stream 1 Fields

Every field in the Stream 1 types is reachable via `harness_query`:

| Stream 1 Field | `harness_query` Path |
|----------------|---------------------|
| `IterationSnapshot.voltages` | `step` + `iterations: true` → `iterationData[].nodes` |
| `IterationSnapshot.prevVoltages` | `step` + `iterations: true` → `iterationData[].prevNodes` (previous-iteration voltages keyed by node label) |
| `IterationSnapshot.preSolveRhs` | `step` + `iterations: true` → `iterationData[].rhs` (RHS before solve, labeled by node) |
| `IterationSnapshot.preSolveRhs` | `step` + `iterations: true` → `iterationData[].preSolveRhs` (Stream 3) |
| `IterationSnapshot.matrix` | `harness_compare_matrix` |
| `IterationSnapshot.elementStates` | `component` + `step` + `iterations: true` → `componentIterationJSON.states` |
| `IterationSnapshot.noncon` | `step` + `iterations: true` → `iterationData[].noncon` |
| `IterationSnapshot.globalConverged` | `step` + `iterations: true` → `iterationData[].globalConverged` |
| `IterationSnapshot.elemConverged` | `step` + `iteration` + `convergence: true` |
| `StepSnapshot.attempts` | `step` + `iterations: true` → `iterationData[].attempts` |
| `StepSnapshot.cktMode` | `step` + `integrationCoefficients: true` (Stream 3) |
| `SessionSummary.*` | `type: "summary"` |
| `ComparisonResult.voltageDiffs` | `filter: "divergences"` → `divergences[]` type=node |
| `ComparisonResult.rhsDiffs` | `filter: "divergences"` → `divergences[]` type=rhs |
| `ComparisonResult.matrixDiffs` | `harness_compare_matrix` |
| `ComparisonResult.stateDiffs` | `filter: "divergences"` → `divergences[]` type=state |
| `NodeMapping.*` | `harness_describe` → `nodeMapping[]` |
| `TopologySnapshot.elements` | `harness_describe` → `components[]` |
| `TopologySnapshot.nodeLabels` | `harness_describe` → `nodes[]` |

---

## 10. Verification Requirements

All verification uses Vitest (`src/**/__tests__/*.test.ts`) unless noted.

### 10.1 `HarnessSessionState` Unit Tests

File: `scripts/mcp/__tests__/harness-session-state.test.ts`

| Test | Assertion |
|------|-----------|
| `store()` returns sequential handles `h0`, `h1`, ... | |
| `get()` returns the stored entry | |
| `get()` throws with helpful message for unknown handle | Message includes known handles |
| `dispose()` calls `session.dispose()` | Spy on mock session |
| `dispose()` removes handle from map | Subsequent `get()` throws |
| `dispose()` unknown handle throws | Error message includes "Already disposed?" |
| `size` reflects live session count | |
| `handles()` returns all active handles | |

### 10.2 `harness_start` Tests

File: `scripts/mcp/__tests__/harness-tools.test.ts`

| Test | Assertion |
|------|-----------|
| Valid paths → returns handle `h0`, topology populated | |
| `autoGenerate: true` with `.dts` → `.cir` path derived | |
| Missing `dtsPath` → `isError: true`, message contains "file not found" | |
| Missing `cirPath` (no autoGenerate) → `isError: true` | |
| `ComparisonSession.init()` throws → no handle allocated, `isError: true` | |
| `tolerance` overrides propagate to session | |
| Topology output: components have `label`, `type`, `pins`, `slots` | |
| Topology output: nodes have `label`, `index`, `connectedComponents` | |
| Ground node (index 0) absent from `nodes` | |

### 10.3 `harness_run` Tests

| Test | Assertion |
|------|-----------|
| `analysis: "dcop"` calls `runDcOp()` | |
| `analysis: "tran"` without `stopTime` → `isError: true` | |
| `analysis: "tran"` calls `runTransient(0, stopTime, maxStep)` | |
| `summary.firstDivergence` is null when all within tolerance | |
| `summary.firstDivergence` populated when divergence found | |
| `errors[]` populated from `ComparisonSession.errors` | |
| Re-run clears and repopulates results | |
| Unknown handle → `isError: true`, helpful message | |

### 10.4 `harness_query` Tests

| Test | Assertion |
|------|-----------|
| `type: "summary"` → returns `summary` block | |
| `component: "Q1"` → `queryMode: "component-trace"`, steps populated | |
| `component: "Q1"` + `slots: ["Q_*"]` → only `Q_*` slots in output | |
| `component: "UNKNOWN"` → `isError: true`, suggests closest match | |
| `node: "Q1:C"` → `queryMode: "node-trace"` | |
| `step: 0` → `queryMode: "step-end"` | |
| `step: 0` + `iterations: true` → `queryMode: "step-iterations"` | |
| `step` out of range → `isError: true`, includes valid range | |
| `filter: "divergences"` → only `withinTol: false` entries | |
| `filter: "worst"` + `worstN: 3` → top 3 by `absDelta` | |
| `stepRange: [2, 5]` → only steps 2-5 in output | |
| `timeRange: [0, 1e-3]` → steps filtered by simTime | |
| Pagination: `offset: 0, limit: 2` → `total` is full count, `entries` has 2 | |
| `component: "Q1"` + `node: "Q1:C"` → `isError: true`, ambiguous | |
| No primary mode → `isError: true`, lists valid options | |
| `component: "Q1"` + `filter: "divergences"` → `queryMode: "component-divergences"` | |
| `deviceType: "bjt"` → all BJT components in output | |
| `step: 0` + `stateHistory: true` + `component: "Q1"` → state history shape | |

### 10.5 `harness_describe` Tests

| Test | Assertion |
|------|-----------|
| Returns full topology (components, nodes) | |
| `nodeMapping` is `[]` before `harness_run` | |
| `nodeMapping` populated after `harness_run` | Each entry has `ourIndex`, `ngspiceIndex`, `label` |
| Ground node absent | |
| `ComponentInfoDetailed.index` matches `elementIndex` from capture | |

### 10.6 `harness_compare_matrix` Tests

| Test | Assertion |
|------|-----------|
| Valid step+iteration → entries with `rowLabel`, `colLabel` | |
| `filter: "mismatches"` → only `withinTol: false` entries | |
| `filter: "all"` → all captured matrix entries | |
| Pagination: `total` is pre-pagination count | |
| `step` out of range → `isError: true` | |
| `iteration` out of range → `isError: true` | |
| Zero-on-both-sides entries excluded even in `filter: "all"` | |

### 10.7 `harness_export` Tests

| Test | Assertion |
|------|-----------|
| Default (no options) → only summary and divergent steps | |
| `includeAllSteps: true` → all steps present | |
| `onlyDivergences: true` overrides `includeAllSteps` | |
| `path` provided → file written, `writtenTo` populated | |
| No analysis run → `isError: true` | |
| `sizeBytes` reflects `steps` array byte count | |

### 10.8 `harness_dispose` Tests

| Test | Assertion |
|------|-----------|
| Valid handle → `{ success: true }`, session removed | |
| Subsequent call with same handle → `isError: true` | |
| Unknown handle → `isError: true`, "Already disposed?" in message | |
| `ComparisonSession.dispose()` is called once | Spy assertion |

### 10.9 Serialization Unit Tests

File: `scripts/mcp/__tests__/harness-serialization.test.ts`

| Test | Assertion |
|------|-----------|
| `formatEngineering(1.234e-12)` → `{ raw: 1.234e-12, display: "1.234p" }` | |
| `formatEngineering(NaN)` → `{ raw: null, display: "—" }` | |
| `formatEngineering(0)` → `{ raw: 0, display: "0.000" }` | |
| `formatEngineering(-3.3e-3)` → `{ raw: -3.3e-3, display: "−3.300m" }` | |
| `comparedValueToJSON(cv)` → `NaN` in `ours` maps to `raw: null` | |
| `comparedValueToJSON(cv)` → `delta.raw: null` when either side is `NaN` | |
| `globMatch("Q_*", "Q_BE")` → `true` | |
| `globMatch("Q_*", "CCAP_BC")` → `false` | |
| `globMatch("CCAP_*", "CCAP_BC")` → `true` | |
| `matrixPositionLabel(3, 5, nodeLabels)` → `"G[Q1:B, Q1:C]"` | |
| `resolveNodeLabel(0, nodeLabels)` → `"gnd"` | Not `"row0"` |

---

## Appendix: Glob Matching for Slot Filters

The `slots` parameter in `harness_query` accepts an array of glob patterns. Only `*` is
supported as a wildcard (no `?`, no `[...]`, no `**`). Matching is case-insensitive.

```typescript
function globMatch(pattern: string, value: string): boolean {
  const regexStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return new RegExp(regexStr, "i").test(value);
}

function matchesAnyGlob(patterns: string[], value: string): boolean {
  return patterns.some(p => globMatch(p, value));
}
```

If `slots` is empty or absent, all slots pass.

---

## Appendix: Engineering Notation Formatter

Reference implementation for `formatEngineering()`:

```typescript
const PREFIXES: Array<[number, string]> = [
  [1e12,  "T"], [1e9,  "G"], [1e6,  "M"], [1e3,  "k"],
  [1,     "" ], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"],
  [1e-12, "p"], [1e-15,"f"],
];

function formatEngineering(value: number): FormattedNumber {
  if (Number.isNaN(value)) return { raw: null, display: "—" };
  if (!Number.isFinite(value)) return { raw: value, display: value > 0 ? "+Inf" : "−Inf" };
  if (value === 0) return { raw: 0, display: "0.000" };

  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);

  for (const [threshold, prefix] of PREFIXES) {
    if (abs >= threshold * 0.9995) {  // 0.9995 avoids rounding to next tier
      const scaled = abs / threshold;
      return { raw: value, display: `${sign}${scaled.toFixed(3)}${prefix}` };
    }
  }

  // Below femto
  const [threshold, prefix] = PREFIXES[PREFIXES.length - 1]!;
  const scaled = abs / threshold;
  return { raw: value, display: `${sign}${scaled.toFixed(3)}${prefix}` };
}
```
