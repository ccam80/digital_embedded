# Facade Unification Spec

**Status**: Draft
**Scope**: Unify the three divergent interface layers (UI, PostMessage, MCP/CLI) behind a single concrete `SimulatorFacade` implementation. Eliminate all duplicate code paths, stale-engine bugs, and clock-handling gaps.

**Prerequisite reading**: This spec references the architecture audit performed 2026-03-19 which identified 10 divergence issues across the headless API, UI, and MCP layers.

---

## 1. Problem Statement

The project has three consumers of the simulation engine (UI in `app-init.ts`, PostMessage adapter, MCP server) that each wire together the same core modules differently. This causes:

1. **Stale engine state in UI** — `app-init.ts:361` creates one `DigitalEngine` and reuses it across recompilations via `engine.init(compiled)`. The headless path (`SimulationRunner._defaultEngineFactory` at `runner.ts:101-105`) creates a fresh engine per compile. Bugs caused by leftover state in the reused engine are invisible to headless tests.

2. **Dual engine desync in PostMessage** — When GUI hooks are present, `PostMessageAdapter._loadCircuit()` (`postmessage-adapter.ts:542-553`) loads the circuit into the UI AND compiles a separate headless engine. After the user edits the circuit in the UI, the adapter's engine is stale. `digital-step` / `digital-read-output` hit the stale engine.

3. **Clock management is UI-only** — `ClockManager.advanceClocks()` is called only in `app-init.ts` (lines 855, 1593, 1678). Neither PostMessage `digital-step` nor MCP `circuit_test` advance clocks. Sequential circuits behave differently across interfaces.

4. **Pin position divergence in compiler** — `compiler.ts:133-134` computes pin world positions as `el.position.x + pin.position.x` (raw addition). `netlist.ts:107` correctly uses `pinWorldPosition(el, pin)` which handles rotation/mirror transforms. Programmatically-built circuits with rotation can miscompile.

5. **Triple net-resolution implementation** — Wire tracing via union-find exists in `compiler.ts:110-290`, `net-resolver.ts:120-306` (dead code), and `netlist.ts:41-404`. Each has different error handling and pin position logic.

6. **No concrete facade** — `SimulatorFacade` (`facade.ts:26-283`) is an interface with no implementation. `CircuitBuilder`, `SimulationRunner`, and `SimulationLoader` each implement parts. Every consumer composes them ad-hoc.

7. **`detectInputCount` duplicated** — Identical logic in `postmessage-adapter.ts:579-597` and `circuit-mcp-server.ts:64-99`.

8. **Facade interface contract mismatch** — `SimulatorFacade.patch()` declares return type `Diagnostic[]` but `CircuitBuilder.patch()` returns `PatchResult` (diagnostics + addedIds).

---

## 2. Design Decisions

These are binding for implementation. Reference the analog decisions in memory (D1-D29) which remain unaffected.

- **F1**: One concrete class `DefaultSimulatorFacade` implements `SimulatorFacade`. It composes `CircuitBuilder`, `SimulationRunner`, `SimulationLoader`, and `ClockManager` internally. No consumer instantiates these individually for production use.

- **F2**: Engine lifecycle is always fresh-per-compile. `compile()` creates a new `DigitalEngine` (or `MNAEngine` for analog) every time. The UI's pattern of reusing a single engine across recompilations is eliminated.

- **F3**: `ClockManager` is internal to the facade. `step()`, `run()`, and `runToStable()` on the facade advance clocks before each engine step. The facade exposes `clockAdvance: boolean` option (default `true`) to allow raw stepping for test executors that manage clocks themselves.

- **F4**: The PostMessage adapter does NOT maintain its own engine. When GUI hooks are present, simulation commands (`digital-set-input`, `digital-step`, `digital-read-output`) delegate to the UI's facade instance via hooks. When headless (no GUI hooks), the adapter creates its own facade instance.

- **F5**: Net resolution is extracted into a shared `traceNets()` function. The compiler and headless netlist both call it. The compiler transforms the result into wiring tables; the netlist transforms it into diagnostics.

- **F6**: `pinWorldPosition()` is the single source of truth for pin coordinates everywhere — compiler, netlist, builder. Raw `el.position.x + pin.position.x` addition is eliminated.

- **F7**: `detectInputCount()` lives in `src/testing/detect-input-count.ts` and is imported by all consumers.

- **F8**: `SimulatorFacade.patch()` return type is updated to `PatchResult` (not `Diagnostic[]`).

- **F9**: `src/engine/net-resolver.ts` is deleted. Its test file is migrated or deleted.

- **F10**: The facade manages a `CompiledCircuit` ↔ `SimulationEngine` pairing internally. External code never calls `engine.init()`, `engine.step()`, or `engine.setSignalValue()` directly. The facade is the only path to the engine.

- **F11**: The existing `SimulationRunner` class is retained as an internal implementation detail of the facade (not deleted, not public API). `CircuitBuilder` is also retained internally. This minimizes churn — the facade is a composition wrapper, not a rewrite.

---

## 3. Architectural Constraint Preserved

Per CLAUDE.md "Engine-Agnostic Editor" constraint: the editor/renderer/interaction layer remains engine-agnostic. The facade IS the pluggable engine interface referenced in that constraint. The canvas, grid, wire routing, selection, and undo/redo code continues to have zero simulation imports. The facade exposes signal values by label; the editor binding translates between netId-based rendering and label-based facade access.

The analog engine (`MNAEngine`, `compileAnalogCircuit`) is routed through the same facade. `compile()` dispatches on `circuit.metadata.engineType` (already done in `SimulationRunner.compile()` at `runner.ts:85-88`).

---

## 4. What to Create

### 4.1 `src/headless/default-facade.ts` — NEW FILE

Concrete implementation of `SimulatorFacade`.

```
export class DefaultSimulatorFacade implements SimulatorFacade {
  private readonly _builder: CircuitBuilder;
  private readonly _runner: SimulationRunner;
  private readonly _loader: SimulationLoader;
  private readonly _registry: ComponentRegistry;

  // Active session state (per compile)
  private _circuit: Circuit | null = null;
  // Stored as concrete type internally for getSignalArray() access;
  // exposed externally as SimulationEngine via compile() return type.
  private _engine: DigitalEngine | MNAEngine | null = null;
  private _clockManager: ClockManager | null = null;
  private _compiled: ConcreteCompiledCircuit | null = null;

  constructor(registry: ComponentRegistry)

  // --- Building (delegates to _builder) ---
  createCircuit(opts?): Circuit
  addComponent(circuit, typeName, props?): CircuitElement
  connect(circuit, src, srcPin, dst, dstPin): Wire
  build(spec: CircuitSpec): Circuit
  patch(circuit, ops, opts?): PatchResult     // F8: returns PatchResult

  // --- Compilation ---
  compile(circuit: Circuit): SimulationEngine
    // F2: creates fresh DigitalEngine or MNAEngine every time
    // Disposes previous engine if one exists (calls engine.dispose())
    // Internalizes ClockManager creation (digital only)
    // Stores _circuit, _engine, _clockManager, _compiled

  // --- Simulation (F3: clock-aware) ---
  step(engine, opts?: { clockAdvance?: boolean }): void
    // Default: _clockManager.advanceClocks(engine.getSignalArray()) then engine.step()
    // opts.clockAdvance=false skips clock advancement
    // Note: _engine is stored as DigitalEngine|MNAEngine internally,
    //   so getSignalArray() is available without casting through SimulationEngine.
    //   For analog engines, clock advancement is skipped (no clocks in analog).
  run(engine, cycles, opts?): void
  runToStable(engine, maxIterations?, opts?): void
  setInput(engine, label, value): void
  readOutput(engine, label): number
  readAllSignals(engine): Record<string, number>
    // NOTE: SimulationRunner.readAllSignals() returns Map<string, number>.
    // The facade MUST convert: Object.fromEntries(this._runner.readAllSignals(engine))

  // --- Testing ---
  runTests(engine, circuit, testData?): TestResults

  // --- File I/O ---
  loadDigXml(xml: string): Circuit             // Sync — parses XML string directly
  serialize(circuit): string
  deserialize(json): Circuit                   // Returns Circuit, not string

  // --- Introspection ---
  netlist(circuit): Netlist
  validate(circuit): Diagnostic[]
  describeComponent(typeName): ComponentDefinition | undefined

  // --- Session management (new, not on interface) ---
  getEngine(): SimulationEngine | null         // For hook wiring (returns _engine as SimulationEngine)
  getClockManager(): ClockManager | null       // For UI clock phase sync
  getCompiled(): ConcreteCompiledCircuit | null // For editor binding (wireToNetId, pinNetMap)
  getCompiledAnalog(): CompiledAnalogCircuit | null // For analog UI feedback (diagnostics, nodeIds)
  getDcOpResult(): DcOpResult | null           // Last DC operating point result
  invalidate(): void                            // Marks engine stale, disposes engine
}
```

**Internal composition**:
- `_builder` = `new CircuitBuilder(registry)`
- `_runner` = `new SimulationRunner(registry)`
- `_loader` = `new SimulationLoader(registry)`
- Building methods delegate to `_builder.*`
- Compilation delegates to `_runner.compile()` then wraps with `ClockManager`
- Simulation methods delegate to `_runner.*` with clock pre-step via `_clockManager.advanceClocks(_engine.getSignalArray())`
- `readAllSignals` delegates to `_runner.readAllSignals()` then converts `Map` → `Record` via `Object.fromEntries()`
- I/O: `loadDigXml` delegates to `_builder.loadDig()` (sync, XML only). File-path loading stays on `SimulationLoader` directly — MCP/CLI consumers read files themselves and pass XML.
- Introspection delegates to `_builder.netlist/validate/describeComponent`

### 4.2 `src/testing/detect-input-count.ts` — NEW FILE

Extract from `circuit-mcp-server.ts:64-99` and `postmessage-adapter.ts:579-597`:

```
export function detectInputCount(
  circuit: Circuit,
  registry: ComponentRegistry,
  testDataStr: string,
): number | undefined
```

Single implementation, imported by `PostMessageAdapter`, MCP server, and CLI.

### 4.3 `src/engine/net-trace.ts` — NEW FILE

Shared net-tracing core extracted from `compiler.ts:110-290` and `netlist.ts:41-404`.

```
export interface TracedNet {
  netId: number;
  slots: number[];          // Pin slots in this net
  driverCount: number;
  width: number | null;     // null = not yet inferred
}

export interface NetTraceResult {
  nets: TracedNet[];
  slotToNetId: number[];    // slot index → net ID
  netCount: number;
}

export function traceNets(
  elements: readonly CircuitElement[],
  wires: readonly Wire[],
  registry: ComponentRegistry,
): NetTraceResult
```

Algorithm:
1. Collect all pins with `pinWorldPosition()` (F6)
2. Build position map
3. Union-find merge pins at same position
4. Add wire virtual nodes, union start↔end
5. Merge same-position nodes
6. Merge Tunnel components with same label
7. Assign net IDs from union-find roots
8. Return `NetTraceResult`

No error handling in this function — it produces raw topology. Consumers add their own validation:
- **Compiler** (`compiler.ts`): transforms `NetTraceResult` into wiring tables, throws `BitsException` on width mismatch
- **Netlist** (`netlist.ts`): transforms `NetTraceResult` into `Netlist` with collected `Diagnostic[]`

---

## 5. What to Modify

### 5.1 `src/headless/facade.ts` — MODIFY

| Line | Change |
|------|--------|
| 282 | Change `patch()` return type from `Diagnostic[]` to `PatchResult` |
| 180 | Change `loadDig(pathOrXml: string): Circuit` to `loadDigXml(xml: string): Circuit` — sync, XML-only. File-path loading is handled by `SimulationLoader` directly at call sites that need it (MCP server, CLI). |

Import `PatchResult` from `netlist-types.ts`.

### 5.2 `src/headless/index.ts` — MODIFY

Add export: `export { DefaultSimulatorFacade } from './default-facade.js';`

### 5.3 `src/engine/compiler.ts` — MODIFY

| Lines | Change |
|-------|--------|
| 110-290 (approx) | Replace inline union-find net tracing with call to `traceNets()` from `src/engine/net-trace.ts`. Keep steps 4-9 (SCC, topo sort, wiring table, function table, etc.) which are compiler-specific. |
| 131-134, 173-176 | Eliminated — `traceNets()` uses `pinWorldPosition()` internally (F6) |

The compiler becomes:
```
import { traceNets } from './net-trace.js';

// Step 1: Enumerate components (unchanged)
// Step 2-3: replaced by traceNets()
const traced = traceNets(elements, wires, registry);
// Step 4+: SCC, topo sort, etc. using traced.slotToNetId
```

### 5.4 `src/headless/netlist.ts` — MODIFY

| Lines | Change |
|-------|--------|
| 41-180 (approx) | Replace inline union-find net tracing with call to `traceNets()`. Keep diagnostic generation (width validation, unconnected-input, multi-driver) and descriptor construction. |

```
import { traceNets } from '../engine/net-trace.js';

export function resolveNets(circuit, registry): Netlist {
  const traced = traceNets(circuit.elements, circuit.wires, registry);
  // Width validation → diagnostics
  // Build ComponentDescriptor[], NetDescriptor[]
  // Return Netlist
}
```

### 5.5 `src/app/app-init.ts` — MODIFY (major)

**Goal**: Replace direct engine/compiler usage with `DefaultSimulatorFacade`.

| Current code | Replacement |
|---|---|
| `import { DigitalEngine } from '../engine/digital-engine.js'` (line 55) | Remove |
| `import { compileCircuit } from '../engine/compiler.js'` (line 56) | Remove |
| `import { ClockManager } from '../engine/clock.js'` (line 57) | Remove |
| `import { compileAnalogCircuit } from '../analog/compiler.js'` (line 80) | Remove |
| `import { MNAEngine } from '../analog/analog-engine.js'` (line 81) | Remove |
| `import { SimulationRunner } from '../headless/runner.js'` (line 72) | Remove |
| Add: `import { DefaultSimulatorFacade } from '../headless/default-facade.js'` | New |
| `const engine = new DigitalEngine('level')` (line 361) | `const facade = new DefaultSimulatorFacade(registry)` |
| `let compiled: CompiledCircuitImpl \| null = null` (line 364) | Access via `facade.getCompiled()` |
| `let clockManager: ClockManager \| null = null` (line 365) | Access via `facade.getClockManager()` |
| `let analogEng: MNAEngine \| null = null` (line 366) | Managed internally by facade |
| `let analogCompiled: CompiledAnalogCircuit \| null = null` (line 367) | Managed internally by facade |

**`compileAndBind()` function** (lines 428-541):

Replace the two compilation paths (analog lines 439-501, digital lines 514-540) with:
```
function compileAndBind(): boolean {
  const isAnalog = circuit.metadata.engineType === 'analog';

  // Clean up previous engine (facade.compile() calls dispose internally)
  if (binding.isBound) {
    binding.unbind();
  }

  if (!isAnalog) {
    // Pre-validate for digital (analog compiler does its own validation)
    const diagnostics = facade.validate(circuit);
    const errors = diagnostics.filter(d => d.severity === 'error');
    if (errors.length > 0) {
      showStatus(`Compilation error: ${formatDiagnostics(errors)}`, true);
      return false;
    }
  }

  try {
    const engine = facade.compile(circuit);

    if (isAnalog) {
      // Analog-specific UI feedback:
      // facade.compile() ran compileAnalogCircuit + MNAEngine.init + dcOperatingPoint
      // Check for warnings/convergence via facade analog accessors
      const compiled = facade.getCompiledAnalog();
      if (compiled) {
        const compileErrors = compiled.diagnostics.filter(d => d.severity === 'error');
        if (compileErrors.length > 0) {
          showStatus(`Analog circuit problem: ${compileErrors.map(d => d.summary).join(' | ')}`, true);
          return false;
        }
        const compileWarnings = compiled.diagnostics.filter(d => d.severity === 'warning');
        if (compileWarnings.length > 0) {
          console.warn('Analog compilation warnings:', compileWarnings.map(d => d.summary));
        }
      }
      // Re-resolve analog watched signals
      if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
        // ... existing analog viewer re-resolution logic (lines 481-489)
      }
    } else {
      // Digital: bind editor to engine for wire signal rendering
      const compiled = facade.getCompiled();
      if (compiled) {
        binding.bind(circuit, engine, compiled.wireToNetId, compiled.pinNetMap);
      }
      // Re-resolve digital watched signals
      if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
        // ... existing digital viewer re-resolution logic (lines 523-532)
      }
    }

    compiledDirty = false;
    clearStatus();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAnalog) {
      showStatus(`Analog compilation error: ${_friendlyAnalogError(msg, circuit)}`, true);
    } else {
      showStatus(`Compilation error: ${msg}`, true);
    }
    return false;
  }
}
```

**Interactive toggle** (lines 840-862):

Replace `clockManager.advanceClocks(engine.getSignalArray())` + `engine.step()` with:
```
facade.step(engine, { clockAdvance: elementHit.typeId !== 'Clock' });
```

Clock phase sync (line 849) uses `facade.getClockManager()?.setClockPhase(netId, newVal !== 0)`.

**Continuous run loop** (lines 1592-1595):

Replace:
```
if (clockManager !== null) clockManager.advanceClocks(engine.getSignalArray());
engine.step();
```
With:
```
facade.step(engine); // clocks advanced internally
```

**Single step button** (lines 1676-1678):

Same replacement — `facade.step(engine)` instead of manual clock+step.

**Analysis** (line 3548-3549):

Replace:
```
const runner = new SimulationRunner(registry);
const result = analyseCircuit(runner as unknown as SimulatorFacade, circuit);
```
With:
```
const result = analyseCircuit(facade, circuit);
```

### 5.6 `src/io/postmessage-adapter.ts` — MODIFY (major)

**Goal**: Eliminate the dual-engine pattern (F4).

| Current code | Replacement |
|---|---|
| `private _runner: SimulationRunner \| null = null` (line 145) | Remove |
| `private _engine: SimulationEngine \| null = null` (line 146) | Remove |
| `import { SimulationRunner } from '../headless/runner.js'` (line 52) | Remove |
| `_compileForHeadless()` method (lines 557-560) | Remove entirely |
| `_requireHeadless()` method (lines 571-576) | Remove entirely |

**New hooks added to `PostMessageHooks`** (after line 103):

```
/** Step the simulation (advance clocks + propagate). */
step?(): void;

/** Drive an input by label. */
setInput?(label: string, value: number): void;

/** Read an output by label. */
readOutput?(label: string): number;

/** Read all labeled signals. */
readAllSignals?(): Record<string, number>;

/** Compile the current circuit (for test execution). */
compile?(): SimulationEngine;

/** Get the facade instance (for test runners that need it). */
getFacade?(): import('../headless/facade.js').SimulatorFacade;
```

**Handler changes**:

`_handleSetInput` (line 300): Delegate to `hooks.setInput?.(label, value)` when present; fall back to own facade for headless-only mode.

`_handleStep` (line 305): Delegate to `hooks.step?.()` when present.

`_handleReadOutput` (line 310): Delegate to `hooks.readOutput?.(label)` when present.

`_handleReadAllSignals` (line 317): Delegate to `hooks.readAllSignals?.()` when present.

`_handleRunTests` (line 333) and `_handleTestTutorial` (line 368): Use `hooks.getFacade?.()` or own facade to compile fresh + run tests. Replace inline `_detectInputCount` with imported `detectInputCount()`.

`_loadCircuit` (line 542): Remove the `_compileForHeadless(circuit)` call on line 547. The UI hooks handle compilation; the facade is shared.

**`_handleLoadJson`** (line 290): Currently calls `_compileForHeadless()` which is being deleted. Replace with: when hooks are present, call `hooks.loadCircuitXml?.(xml)` (the DTS deserializer produces a Circuit that can be serialized back to XML, or add a `loadCircuit?(circuit: Circuit)` hook). When headless, use the adapter's own facade instance to compile.

**Headless-only mode** (no GUI hooks): The adapter creates its own `DefaultSimulatorFacade` internally and uses it for all operations. This preserves headless postMessage usage for testing.

### 5.7 `src/app/app-init.ts` PostMessage hook wiring (lines ~4262-4342) — MODIFY

The hooks object passed to `PostMessageAdapter` gains the new simulation hooks:

```
hooks: {
  // ... existing hooks (loadCircuitXml, getCircuit, serializeCircuit, etc.)

  step() {
    if (!compiledDirty) facade.step(facade.getEngine()!);
    scheduleRender();
  },
  setInput(label: string, value: number) {
    if (facade.getEngine()) facade.setInput(facade.getEngine()!, label, value);
  },
  readOutput(label: string): number {
    return facade.readOutput(facade.getEngine()!, label);
  },
  readAllSignals(): Record<string, number> {
    return facade.readAllSignals(facade.getEngine()!);
  },
  getFacade() { return facade; },
}
```

### 5.8 `scripts/circuit-mcp-server.ts` — MODIFY

| Current code | Replacement |
|---|---|
| `import { CircuitBuilder }` (line 17) | `import { DefaultSimulatorFacade }` |
| `import { SimulationLoader }` (line 18) | Remove (facade provides loadDig) |
| `import { SimulationRunner }` (line 19) | Remove (facade provides compile/step) |
| `const builder = new CircuitBuilder(registry)` (line 108) | `const facade = new DefaultSimulatorFacade(registry)` |
| `const loader = new SimulationLoader(registry)` (line 109) | Remove |
| `const runner = new SimulationRunner(registry)` (line 110) | Remove |
| `detectInputCount()` function (lines 64-99) | `import { detectInputCount } from '../src/testing/detect-input-count.js'` |

All tool implementations change from `builder.*/runner.*/loader.*` to `facade.*`:

| Tool | Current call | New call |
|---|---|---|
| `circuit_build` | `builder.build(spec)` | `facade.build(spec)` |
| `circuit_netlist` | `builder.netlist(circuit)` | `facade.netlist(circuit)` |
| `circuit_validate` | `builder.validate(circuit)` | `facade.validate(circuit)` |
| `circuit_describe` | `builder.describeComponent(name)` | `facade.describeComponent(name)` |
| `circuit_patch` | `builder.patch(circuit, ops)` | `facade.patch(circuit, ops)` |
| `circuit_compile` | `runner.compile(circuit)` | `facade.compile(circuit)` |
| `circuit_test` | `runner.compile()` + `executeTests(runner,...)` | `facade.compile()` + `facade.runTests()` |
| `circuit_test_equivalence` | `runner.compile/setInput/runToStable/readOutput` | `facade.compile/setInput/runToStable/readOutput` |
| `circuit_load` | `loadWithSubcircuits()` + `builder.netlist()` | `loadWithSubcircuits()` + `facade.netlist()` (load stays direct — needs subcircuit registration side effects) |

### 5.9 `scripts/circuit-cli.ts` — MODIFY

Same pattern as MCP server: replace `builder`/`runner` with single `facade` instance.

### 5.10 `src/headless/builder.ts` — MODIFY (minor)

`runTests()` method (lines 311-327): Currently creates its own `new SimulationRunner(this.registry)`. This method will be called by the facade, which already has a runner. Change to accept the runner as a parameter or remove the method (facade handles test orchestration directly).

### 5.11 `src/analysis/model-analyser.ts` — MODIFY (minor)

Line where `analyseCircuit` accepts `SimulatorFacade` — verify the type is satisfied by `DefaultSimulatorFacade`. The current code at `app-init.ts:3549` casts `SimulationRunner as unknown as SimulatorFacade`. With the real facade, this cast is eliminated.

---

## 6. What to Delete

| File | Reason | Importers to update |
|---|---|---|
| `src/engine/net-resolver.ts` | Dead code — no production imports (F9) | None |
| `src/engine/__tests__/net-resolver.test.ts` | Tests dead code. Migrate any unique coverage to `net-trace.test.ts` or `netlist.test.ts` | None |

---

## 6.1 Scripts Exemption

Utility scripts in `scripts/` that directly use `CircuitBuilder`, `SimulationRunner`, or `DigitalEngine` are **not migrated** to the facade. These are dev/build tools, not production code:

- `scripts/verify-fixes.ts`
- `scripts/generate-all-components-fixture.ts`
- `scripts/test-set-patch.ts`
- `scripts/test-rtc-build.ts`
- `scripts/patch-analysis-dialog.cjs`

They may continue using the internal classes directly. If any break due to interface changes in `CircuitBuilder` or `SimulationRunner` during Phase C, fix them as incidental cleanup — they are not part of the no-deviation checklist.

Test files under `src/` that test `SimulationRunner`, `CircuitBuilder`, etc. directly (e.g., `runner.test.ts`, `integration.test.ts`, `builder.test.ts`) remain valid as **internal module tests** and are not modified.

## 6.2 Engine Lifecycle Notes

The facade's `compile()` method must handle engine lifecycle transitions:

1. If a previous `_engine` exists, call `_engine.stop()` (if state is RUNNING) then `_engine.dispose()` before creating the new engine.
2. The facade does NOT expose `start()` / `stop()` for continuous run. The UI's continuous run loop calls `facade.step()` repeatedly via `requestAnimationFrame`. The engine's `start()`/`stop()`/`getState()` are used by the UI for its own state management but are accessed via `facade.getEngine()`, not through the facade itself.
3. If `facade.step()` is called while the engine's state is RUNNING (continuous run active), it simply delegates — no conflict, since the UI's RAF loop is the only caller.

## 7. Files NOT Modified

These files are explicitly out of scope:

- `src/core/engine-interface.ts` — `SimulationEngine` interface unchanged
- `src/core/analog-engine-interface.ts` — `AnalogEngine` interface unchanged
- `src/engine/digital-engine.ts` — `DigitalEngine` class unchanged
- `src/analog/analog-engine.ts` — `MNAEngine` class unchanged
- `src/engine/compiled-circuit.ts` — `CompiledCircuitImpl` unchanged
- `src/testing/executor.ts` — `executeTests()` unchanged
- `src/testing/parser.ts` — `parseTestData()` unchanged
- `src/headless/auto-layout.ts` — unchanged
- `src/headless/address.ts` — unchanged
- `src/headless/netlist-types.ts` — unchanged (except if `PatchResult` type needs adjusting)
- `src/components/` — all component implementations unchanged
- `src/editor/` — all editor code unchanged
- All analog design decisions D1-D29 — unaffected

---

## 8. Migration Order

Phases are ordered to keep the build green at each step.

### Phase A: Foundation (no behavioral change)

1. **Create `src/engine/net-trace.ts`** — extract shared tracing from `compiler.ts` + `netlist.ts`
2. **Create `src/engine/__tests__/net-trace.test.ts`** — test the extracted function
3. **Modify `src/engine/compiler.ts`** — use `traceNets()`, fix pin position to `pinWorldPosition()` (F6)
4. **Modify `src/headless/netlist.ts`** — use `traceNets()`
5. **Run all existing tests** — must pass unchanged (same behavior, different internal structure)
6. **Delete `src/engine/net-resolver.ts`** and its test file

### Phase B: Facade creation (additive, no consumers yet)

7. **Create `src/testing/detect-input-count.ts`** — extract from MCP server
8. **Modify `src/headless/facade.ts`** — update `patch()` return type to `PatchResult` (F8)
9. **Create `src/headless/default-facade.ts`** — `DefaultSimulatorFacade` class
10. **Create `src/headless/__tests__/default-facade.test.ts`** — comprehensive tests
11. **Modify `src/headless/index.ts`** — add `DefaultSimulatorFacade` export

### Phase C: Consumer migration (one at a time, test after each)

12. **Modify `scripts/circuit-mcp-server.ts`** — use facade. Run MCP tool tests.
13. **Modify `scripts/circuit-cli.ts`** — use facade. Run CLI tests.
14. **Modify `src/io/postmessage-adapter.ts`** — eliminate dual engine, add hooks. Run postMessage adapter tests.
15. **Modify `src/app/app-init.ts`** — use facade, remove direct engine/compiler imports. Run e2e tests.

### Phase D: Cleanup

16. **Remove dead imports** from MCP server (per agent audit: `SimulationLoader` instantiated but unused at line 109, `parseDigXml`/`loadDigCircuit`/`serializeCircuit` imported but unused)
17. **Final full test run** — unit, integration, e2e

---

## 9. Test Strategy

### New tests required

| Test file | What it covers |
|---|---|
| `src/engine/__tests__/net-trace.test.ts` | `traceNets()`: position merging, wire chaining, tunnel merging, rotation/mirror pin positions |
| `src/headless/__tests__/default-facade.test.ts` | Full lifecycle: `build → compile → step (with clocks) → readOutput → readAllSignals → runTests` |
| `src/headless/__tests__/default-facade.test.ts` | Clock advancement: verify clocks tick on `step()`, don't tick with `{ clockAdvance: false }` |
| `src/headless/__tests__/default-facade.test.ts` | Fresh engine per compile: compile twice, verify no state leakage |
| `src/headless/__tests__/default-facade.test.ts` | Analog dispatch: facade routes analog circuits to MNA engine |
| `src/testing/__tests__/detect-input-count.test.ts` | Input count detection from header + circuit labels |
| `src/io/__tests__/postmessage-adapter.test.ts` | Existing tests updated: verify `digital-step` delegates to hooks when present |

### Existing tests that must continue passing

All files under:
- `src/engine/__tests__/` (compiler, digital-engine, bus-resolution, clock, etc.)
- `src/headless/__tests__/` (builder, integration, runner, test-runner, trace)
- `src/testing/__tests__/` (executor, parser, run-all)
- `src/io/__tests__/` (postmessage-adapter)
- `e2e/` (all end-to-end tests)

### Regression canary

The specific bug class this fixes: "sequential circuit with Clock works in MCP `circuit_test` but flip-flops don't toggle via PostMessage `digital-step`". Write an explicit integration test:

```
test('digital-step via postMessage advances clocks', () => {
  // Build a D flip-flop circuit with Clock
  // Load via postMessage adapter with hooks
  // Send digital-set-input D=1
  // Send digital-step (multiple times for clock edge)
  // Send digital-read-output Q
  // Assert Q=1 (clock ticked, FF latched)
});
```

---

## 10. No-Deviation Checklist

Implementation agents MUST follow this list exactly. No additions, no omissions, no "improvements".

### CREATE these files:
- [ ] `src/engine/net-trace.ts` — `traceNets()` function + `TracedNet`, `NetTraceResult` types
- [ ] `src/engine/__tests__/net-trace.test.ts`
- [ ] `src/headless/default-facade.ts` — `DefaultSimulatorFacade` class
- [ ] `src/headless/__tests__/default-facade.test.ts`
- [ ] `src/testing/detect-input-count.ts` — `detectInputCount()` function
- [ ] `src/testing/__tests__/detect-input-count.test.ts`

### DELETE these files:
- [ ] `src/engine/net-resolver.ts`
- [ ] `src/engine/__tests__/net-resolver.test.ts`

### MODIFY these files (and ONLY these files):
- [ ] `src/headless/facade.ts` — `patch()` return type → `PatchResult`
- [ ] `src/headless/index.ts` — add `DefaultSimulatorFacade` export
- [ ] `src/headless/builder.ts` — adjust `runTests()` to not create own runner
- [ ] `src/headless/netlist.ts` — use `traceNets()` instead of inline union-find
- [ ] `src/engine/compiler.ts` — use `traceNets()` instead of inline union-find, fix pin positions
- [ ] `src/io/postmessage-adapter.ts` — eliminate dual engine, add simulation hooks
- [ ] `src/app/app-init.ts` — use `DefaultSimulatorFacade`, remove direct engine imports
- [ ] `scripts/circuit-mcp-server.ts` — use facade, import `detectInputCount`
- [ ] `scripts/circuit-cli.ts` — use facade
- [ ] `src/io/__tests__/postmessage-adapter.test.ts` — update for new hooks
- [ ] `src/analysis/model-analyser.ts` — verify facade type compatibility (may need minor adjustment)

### DO NOT modify:
- Any file in `src/core/`
- Any file in `src/components/`
- Any file in `src/editor/`
- `src/engine/digital-engine.ts`
- `src/engine/union-find.ts`
- `src/analog/` (any file)
- `src/testing/executor.ts`
- `src/testing/parser.ts`

---

## 11. Verification Criteria

The job is done when:

1. `npm test` passes (all unit + integration tests)
2. `npm run build` succeeds with zero type errors
3. E2e tests pass (`npx playwright test`)
4. No file imports `DigitalEngine` except `src/engine/` internals, `src/headless/runner.ts`, `src/engine/worker*.ts`, and `src/analog/mixed-signal-coordinator.ts`
5. No file imports `compileCircuit` except `src/engine/` internals, `src/headless/runner.ts`, and `src/analog/compiler.ts`
6. `grep -r "new SimulationRunner" src/app/ src/io/` returns zero results
7. `grep -r "ClockManager" src/app/` returns zero results (clock management is internal to facade)
8. `grep -r "el.position.x + pin.position.x" src/engine/compiler.ts` returns zero results
9. `src/engine/net-resolver.ts` does not exist
10. The regression canary test (section 9) passes
