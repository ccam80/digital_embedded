# Phase 5b: Eliminate Whole-Circuit Domain Branching

**Goal**: Remove all whole-circuit / whole-simulator analog-vs-digital branching from consumer code. Domain awareness is permitted at the model and grouping level (inside `src/solver/` and `src/compile/`), NEVER at the whole-circuit or whole-simulator level in consumers.

**Depends on**: Phase 5 (completed), Phase 6 (completed).

**Problem**: Phase 5 replaced `engineType` string checks with `coordinator.analogBackend !== null` null-checks — same branching, different syntax. ~50 branch points survive across 6 consumer files.

---

## 1. SimulationCoordinator Interface Changes

The current interface exposes `digitalBackend` and `analogBackend` as nullable properties. Every consumer checks these for null, creating domain branching. The fix: absorb all behaviors consumers extract from backends into the coordinator interface itself.

### 1.1 Capability queries (replace null-checks)

```typescript
/** True when the coordinator can perform micro-step (gate-level single evaluation). */
supportsMicroStep(): boolean;

/** True when the coordinator can run-to-breakpoint. */
supportsRunToBreak(): boolean;

/** True when AC frequency sweep analysis is available. */
supportsAcSweep(): boolean;

/** True when a DC operating point can be computed. */
supportsDcOp(): boolean;

/**
 * Timing model active in this coordinator.
 * - 'discrete': steps are unitless counts (digital). Speed = steps/s.
 * - 'continuous': steps advance simTime in seconds (analog). Speed = sim-s/wall-s.
 * - 'mixed': both timing models active; continuous dominates the render loop.
 */
readonly timingModel: 'discrete' | 'continuous' | 'mixed';
```

**Replaces**: Every `coordinator.analogBackend !== null` and `coordinator.digitalBackend !== null` check in consumers.

### 1.2 Unified feature execution (replace backend reach-through)

```typescript
/** Execute a single micro-step (digital gate-level). No-op if not supported. */
microStep(): void;

/** Run until a breakpoint or halt condition. No-op if not supported. */
runToBreak(): void;

/** DC operating-point analysis. Returns null if no analog domain. */
dcOperatingPoint(): DcOpResult | null;

/** AC sweep analysis. Returns null if not supported. */
acAnalysis(params: AcParams): AcResult | null;

/**
 * Current simulation time in seconds, or null if timing is purely discrete.
 * For mixed circuits, returns the analog engine's simTime.
 */
readonly simTime: number | null;

/**
 * Current engine lifecycle state (unified across backends).
 * RUNNING if any backend is RUNNING. ERROR if any backend is ERROR.
 */
getState(): EngineState;
```

**Replaces**: `coordinator.digitalBackend?.microStep()`, `coordinator.digitalBackend?.runToBreak()`, `coordinator.analogBackend?.dcOperatingPoint()`, `coordinator.digitalBackend?.getState?.()`, `analogEngine.simTime`, `analogEngine.getState()`.

### 1.3 Unified signal snapshot (replace `_snapshotSignals` branching)

```typescript
/**
 * Snapshot all signals for stability detection.
 * Returns a Float64Array covering all nets/nodes across both domains.
 */
snapshotSignals(): Float64Array;

/** Total number of signal slots (nets + nodes) for snapshot sizing. */
readonly signalCount: number;
```

**Replaces**: `_snapshotSignals()` in `DefaultSimulatorFacade` and `SimulationRunner` which branch on `_isDigitalEngine` / `_isAnalogEngine` to call `getSignalRaw` vs `getNodeVoltage`.

### 1.4 Speed control absorbed into coordinator

```typescript
/**
 * Compute how many steps to execute this frame given wall-clock delta.
 * For discrete: uses steps/s rate.
 * For continuous: uses sim-s/wall-s rate + budget limiting.
 */
computeFrameSteps(wallDtSeconds: number): FrameStepResult;

/** Current speed setting. Units depend on timingModel. */
speed: number;

/** Multiply speed by factor (clamped to valid range). */
adjustSpeed(factor: number): void;

/** Parse speed from text input. */
parseSpeed(text: string): void;

/** Format current speed for display (returns value + unit string). */
formatSpeed(): { value: string; unit: string };
```

```typescript
interface FrameStepResult {
  /** How many coordinator.step() calls to make this frame. */
  steps: number;
  /** For continuous: the simTime goal. Null for discrete. */
  simTimeGoal: number | null;
  /** Wall-clock budget in ms (for continuous time-limited stepping). */
  budgetMs: number;
  /** Whether the frame missed its target (continuous only). */
  missed: boolean;
}
```

**Replaces**: The dual `speedControl` (SpeedControl) + `analogTargetRate` / `AnalogRateController` in app-init.ts, and all `isAnalogMode()` branches in speed-up/speed-down/parse/display handlers.

### 1.5 Clock management

```typescript
/** Advance clock signals. No-op if no digital backend or no clocks. */
advanceClocks(): void;
```

`ClockManager` moves from the facade into `DefaultSimulationCoordinator`. The facade's `step()` calls `coordinator.advanceClocks()` before `coordinator.step()`.

### 1.6 Visualization context (replace analog render setup)

```typescript
/**
 * Build a pin-voltage lookup for a specific element.
 * Returns a map of pinLabel -> voltage, or null if no analog domain.
 */
getPinVoltages(element: CircuitElement): Map<string, number> | null;

/**
 * Get the analog node ID for a wire, or undefined if wire is digital/unmapped.
 */
getWireAnalogNodeId(wire: Wire): number | undefined;

/**
 * Get the voltage range (min/max voltage seen).
 * Returns null if no analog domain.
 */
readonly voltageRange: { min: number; max: number } | null;

/**
 * Update voltage tracking after a step batch.
 * No-op if no analog domain.
 */
updateVoltageTracking(): void;
```

**Replaces**: The `posToAnalogNodeId` map construction in app-init.ts, the `elementRenderer.setAnalogContext()` callback, `analogVoltageTracker.update()`, and `analogEngine.getNodeVoltage(nodeId)` calls.

### 1.7 Slider context

```typescript
/**
 * Get slider-eligible properties for an element.
 * Returns property descriptors, or empty array if element is not in the analog partition.
 */
getSliderProperties(element: CircuitElement): SliderPropertyDescriptor[];

/**
 * Update a component property at runtime (hot-patching the engine).
 */
setComponentProperty(element: CircuitElement, key: string, value: number): void;
```

```typescript
interface SliderPropertyDescriptor {
  elementIndex: number;
  key: string;
  label: string;
  currentValue: number;
  unit: string;
  logScale: boolean;
}
```

**Replaces**: The `analogCompiled.elementToCircuitElement` iteration in app-init.ts selection listener.

### 1.8 Measurement signal reading for runtime panels

Currently `AnalogScopePanel` takes a raw `AnalogEngine` and calls `engine.getNodeVoltage(nodeId)`, `engine.getElementCurrent(elementId)`, `engine.getBranchCurrent(branchId)`, and reads `engine.simTime`. `TimingDiagramPanel` takes a raw `SimulationEngine` and calls `engine.getSignalRaw(netId)`. Both register as `MeasurementObserver` on the raw engine.

Both panels must use the coordinator instead. The coordinator already has `readSignal(addr): SignalValue` which handles both domains. Additional methods needed:

```typescript
/**
 * Read element current by element index. Returns null if not available
 * (e.g. digital-only element or no analog domain).
 */
readElementCurrent(elementIndex: number): number | null;

/**
 * Read branch current by branch index. Returns null if not available.
 */
readBranchCurrent(branchIndex: number): number | null;
```

**Panel migration path**:
- Both panels' channel descriptors change from raw `netId: number` to `addr: SignalAddress`
- `onStep()` calls `coordinator.readSignal(addr)` instead of `engine.getSignalRaw()`/`engine.getNodeVoltage()`
- `AnalogScopePanel` constructor takes `SimulationCoordinator` instead of `AnalogEngine`
- `TimingDiagramPanel` constructor takes `SimulationCoordinator` instead of `SimulationEngine`
- Both register as `MeasurementObserver` on the coordinator (already supported)

**Replaces**: `AnalogScopePanel(canvas, analogEngine)` and `TimingDiagramPanel(canvas, engine, channels)` constructors with raw engine dependencies.

### 1.9 Snapshot management for timing diagram

`TimingDiagramPanel` calls `engine.saveSnapshot()` and `engine.restoreSnapshot(id)` for time-cursor scrubbing. These must move to coordinator:

```typescript
/**
 * Save a snapshot of all engine state. Returns an opaque ID.
 * Delegates to the appropriate backend(s).
 */
saveSnapshot(): SnapshotId;

/**
 * Restore engine state from a previously saved snapshot.
 */
restoreSnapshot(id: SnapshotId): void;
```

**Replaces**: Direct `engine.saveSnapshot()` / `engine.restoreSnapshot()` calls in `TimingDiagramPanel`.

### 1.10 Current resolver context

`WireCurrentResolver.resolve()` currently takes `(engine: AnalogEngine, circuit: Circuit, compiled: ResolvedAnalogCircuit)` — reaching into the analog engine for `engine.getElementPinCurrents(eIdx)` and into the compiled circuit for `wireToNodeId`, `elements`, `elementToCircuitElement`. This must be abstracted:

```typescript
/**
 * Build current-resolver data for wire current animation.
 * Returns null if no analog domain.
 */
getCurrentResolverContext(): CurrentResolverContext | null;
```

```typescript
interface CurrentResolverContext {
  /** Wire to node ID mapping for the analog domain. */
  wireToNodeId: ReadonlyMap<Wire, number>;
  /** Analog element instances. */
  elements: readonly AnalogElement[];
  /** Element index to visual CircuitElement mapping. */
  elementToCircuitElement: ReadonlyMap<number, CircuitElement>;
  /** Get pin currents for an element by index. */
  getElementPinCurrents(elementIndex: number): number[];
}
```

`WireCurrentResolver.resolve()` signature changes to accept `CurrentResolverContext` instead of `(engine, circuit, compiled)`. The coordinator builds this from its internal backends.

**Replaces**: `resolver.resolve(analogEngine, circuit, analogCompiled)` in app-init.ts.

### 1.11 `compiled` accessor restriction

The `compiled` property on `SimulationCoordinator` currently exposes `{ digital, analog, wireSignalMap, labelSignalMap, diagnostics }`. Consumers MUST only access the unified maps (`wireSignalMap`, `labelSignalMap`) and `diagnostics`. Access to `compiled.digital` and `compiled.analog` is forbidden in consumer code — these are solver-internal typed outputs.

To enforce this, narrow the `compiled` return type in the interface:

```typescript
/** Unified compilation output. Only unified maps are exposed to consumers. */
readonly compiled: {
  readonly wireSignalMap: ReadonlyMap<Wire, SignalAddress>;
  readonly labelSignalMap: ReadonlyMap<string, SignalAddress>;
  readonly diagnostics: readonly Diagnostic[];
};
```

The concrete `DefaultSimulationCoordinator` keeps the full `CompiledCircuitUnified` internally and exposes it via a narrower interface type. Internal solver code that needs `compiled.digital` / `compiled.analog` casts or uses the concrete class directly.

**Replaces**: All `coordinator.compiled.analog` and `coordinator.compiled.digital` reach-throughs in consumer code (5 violations in app-init.ts).

### 1.12 Remove `digitalBackend` and `analogBackend` from interface

After all consumers are migrated, these two properties are removed from `SimulationCoordinator`. They remain as private fields in `DefaultSimulationCoordinator` for internal use.

---

## 2. DefaultSimulatorFacade Changes

File: `src/headless/default-facade.ts`

### 2.1 Remove `_engineMode`

Delete the `_engineMode: 'digital' | 'analog'` field. Nothing needs it once the coordinator absorbs all behaviors.

### 2.2 Remove `getCompiled()` / `getCompiledAnalog()`

Replace with a single accessor:

```typescript
getCompiledUnified(): CompiledCircuitUnified | null {
  return this._coordinator?.compiled ?? null;
}
```

Callers needing typed compiled data use `coordinator.compiled.digital` / `coordinator.compiled.analog` — but only inside `src/solver/` and `src/compile/`, never in consumers.

### 2.3 Remove `_resolveBackendEngine()` and `_snapshotSignals()`

Both replaced by coordinator methods (`snapshotSignals()`, `signalCount`).

### 2.4 Simplified `step()`

```typescript
step(coordinator: SimulationCoordinator, opts?: StepOptions): void {
  const advance = opts?.clockAdvance !== false;
  if (advance) coordinator.advanceClocks();
  coordinator.step();
}
```

No `instanceof DigitalEngine` check. The coordinator knows if it has clocks.

### 2.5 Simplified `runToStable()`

```typescript
runToStable(coordinator: SimulationCoordinator, maxIterations = 1000, opts?: StepOptions): void {
  const settleOpts = opts ?? { clockAdvance: false };
  for (let iter = 0; iter < maxIterations; iter++) {
    const before = coordinator.snapshotSignals();
    this.step(coordinator, settleOpts);
    const after = coordinator.snapshotSignals();
    let stable = true;
    for (let n = 0; n < before.length; n++) {
      if (before[n] !== after[n]) { stable = false; break; }
    }
    if (stable) return;
  }
  throw new FacadeError(`Circuit did not stabilize within ${maxIterations} iterations.`);
}
```

### 2.6 Simplified `compile()`

```typescript
compile(circuit: Circuit): SimulationCoordinator {
  this._disposeCurrentEngine();
  this._circuit = null;
  this._coordinator = null;

  const unified = compileUnified(circuit, this._registry, getTransistorModels());
  const coordinator = new DefaultSimulationCoordinator(unified);
  this._coordinator = coordinator;
  this._circuit = circuit;
  return coordinator;
}
```

No `_engineMode` derivation, no `hasAnalogOnly` check. ClockManager created inside coordinator.

---

## 3. App-init.ts Changes

### 3.1 Remove `isAnalogMode()` function

Delete entirely. Every call site replaced with capability query or removed.

### 3.2 Unified render loop

```typescript
function startSimulation(): void {
  const coordinator = facade.getCoordinator();
  if (!coordinator) return;
  if (coordinator.getState() === EngineState.RUNNING) return;

  selection.clear();
  coordinator.start();

  // Activate analog visualization if continuous-time domain present
  if (coordinator.timingModel !== 'discrete') {
    _activateAnalogVisualization(coordinator);
  }

  _startRenderLoop(coordinator);
}

function _startRenderLoop(coordinator: SimulationCoordinator): void {
  let lastTime = performance.now();

  const tick = (now: number): void => {
    if (coordinator.getState() !== EngineState.RUNNING) {
      runRafHandle = -1;
      scheduleRender();
      return;
    }

    const wallDt = (now - lastTime) / 1000;
    lastTime = now;
    const frame = coordinator.computeFrameSteps(wallDt);

    try {
      if (frame.simTimeGoal !== null) {
        // Continuous-time: step until simTime goal or budget exhausted
        const stepStart = performance.now();
        facade.step(coordinator);
        while (coordinator.simTime! < frame.simTimeGoal) {
          if (performance.now() - stepStart > frame.budgetMs) break;
          facade.step(coordinator);
          if (coordinator.getState() === EngineState.ERROR) {
            showStatus('Simulation error: solver failed to converge', true);
            stopSimulation();
            return;
          }
        }
      } else {
        // Discrete-time: fixed step count
        for (let i = 0; i < frame.steps; i++) {
          facade.step(coordinator);
        }
      }
    } catch (err) {
      showStatus(`Simulation error: ${err instanceof Error ? err.message : String(err)}`, true);
      stopSimulation();
      return;
    }

    if (coordinator.timingModel !== 'discrete') {
      _updateAnalogVisualization(coordinator);
    }

    scheduleRender();
    runRafHandle = requestAnimationFrame(tick);
  };
  runRafHandle = requestAnimationFrame(tick);
}
```

**Key point**: ONE `requestAnimationFrame` handle, not two. The `timingModel` check inside the loop determines the stepping strategy, not which loop function to call. The `timingModel !== 'discrete'` check is a model-level property of the coordinator (what kinds of signals does this compiled circuit have?), not a whole-simulator mode.

### 3.3 Analog visualization as opt-in enrichment

```typescript
function _activateAnalogVisualization(coordinator: SimulationCoordinator): void {
  analogVoltageTracker.reset();
  const resolver = new WireCurrentResolver();
  currentFlowAnimator = new CurrentFlowAnimator(resolver);
  currentFlowAnimator.setEnabled(true);
  applyCurrentVizSettings(loadEngineSettings());
  wireRenderer.setVoltageTracker(analogVoltageTracker);

  elementRenderer.setAnalogContext((element) => {
    const pinVoltages = coordinator.getPinVoltages(element);
    if (!pinVoltages) return undefined;
    const tracker = analogVoltageTracker;
    const scheme = colorSchemeManager.getActive();
    return {
      getPinVoltage: (pinLabel: string) => pinVoltages.get(pinLabel),
      voltageColor: (voltage: number) => voltageToColor(voltage, tracker, scheme),
    };
  });

  // Slider panel
  const sliderContainer = document.getElementById('slider-panel');
  if (sliderContainer) {
    sliderContainer.style.display = '';
    activeSliderPanel = new SliderPanel(sliderContainer);
    new SliderEngineBridge(activeSliderPanel, coordinator);
  }
}

function _updateAnalogVisualization(coordinator: SimulationCoordinator): void {
  if (currentFlowAnimator) {
    resolver.resolve(coordinator);
    currentFlowAnimator.update(wallDt, circuit);
  }
  coordinator.updateVoltageTracking();
}

function _deactivateAnalogVisualization(): void {
  if (currentFlowAnimator) {
    currentFlowAnimator.setEnabled(false);
    currentFlowAnimator = null;
  }
  wireRenderer.setVoltageTracker(null);
  elementRenderer.setAnalogContext(null);
  if (activeSliderPanel) {
    activeSliderPanel.dispose();
    activeSliderPanel = null;
  }
  const sliderContainer = document.getElementById('slider-panel');
  if (sliderContainer) sliderContainer.style.display = 'none';
}
```

### 3.4 Unified button handlers

```typescript
// Step
document.getElementById('btn-step')?.addEventListener('click', () => {
  if (compiledDirty && !compileAndBind()) return;
  const coordinator = facade.getCoordinator();
  if (!coordinator) return;
  if (coordinator.getState() === EngineState.RUNNING) coordinator.stop();
  try { facade.step(coordinator); clearStatus(); }
  catch (err) { showStatus(`Simulation error: ${...}`, true); }
  scheduleRender();
});

// Micro-step
document.getElementById('btn-micro-step')?.addEventListener('click', () => {
  if (compiledDirty && !compileAndBind()) return;
  const coordinator = facade.getCoordinator();
  if (!coordinator) return;
  if (coordinator.supportsMicroStep()) {
    try { coordinator.microStep(); clearStatus(); }
    catch (err) { showStatus(`Simulation error: ${...}`, true); }
  } else {
    try { facade.step(coordinator); clearStatus(); }
    catch (err) { showStatus(`Simulation error: ${...}`, true); }
  }
  scheduleRender();
});

// Run-to-break
document.getElementById('btn-run-to-break')?.addEventListener('click', () => {
  if (compiledDirty && !compileAndBind()) return;
  const coordinator = facade.getCoordinator();
  if (!coordinator?.supportsRunToBreak()) {
    showStatus('Run-to-break is not available for this circuit type');
    return;
  }
  try { coordinator.runToBreak(); clearStatus(); }
  catch (err) { showStatus(`Simulation error: ${...}`, true); }
  scheduleRender();
});

// Stop
document.getElementById('btn-stop')?.addEventListener('click', () => {
  if (!isSimActive()) return;
  stopSimulation();
  binding.unbind();
  facade.invalidate();
  compiledDirty = true;
  scheduleRender();
});
```

### 3.5 Speed control UI

```typescript
function updateSpeedDisplay(): void {
  const coordinator = facade.getCoordinator();
  if (!coordinator || !speedInput) return;
  const fmt = coordinator.formatSpeed();
  speedInput.value = fmt.value;
  if (speedUnitEl) speedUnitEl.textContent = fmt.unit;
}
```

### 3.6 Palette filtering

```typescript
// Replace isAnalogMode() with component-model-level query
palette.setEngineTypeFilter(
  circuit.elements.some(el => {
    const def = registry.get(el.typeId);
    return def !== undefined && hasAnalogModel(def) && !hasDigitalModel(def);
  }) ? 'analog' : null
);
```

This queries the circuit's component definitions, not the simulator's backend — component-model-level, not whole-simulator-level.

### 3.7 `isSimActive()` simplification

```typescript
function isSimActive(): boolean {
  const coordinator = facade.getCoordinator();
  return coordinator !== null && coordinator.getState() === EngineState.RUNNING;
}
```

### 3.8 AC sweep

```typescript
if (!coordinator?.supportsAcSweep()) {
  showStatus('AC Sweep requires a circuit with analog components', true);
  return;
}
```

### 3.9 Wire viewer / watched signals

Use `coordinator.compiled.wireSignalMap` and `coordinator.compiled.labelSignalMap` uniformly. No `analogCompiled.wireToNodeId` / `analogCompiled.labelToNodeId` reach-through.

---

## 4. Other Consumer File Changes

### 4.1 EditorBinding (`src/integration/editor-binding.ts`)

- Remove `get engine()` property. Callers use `coordinator` directly.
- Signal value construction branching on `addr.domain` is acceptable — `SignalAddress` is a per-signal discriminated union, not a whole-circuit mode.

### 4.2 DataTablePanel (`src/runtime/data-table.ts`)

**Current state**: Constructor duck-type checks for analog via `getNodeVoltage` presence. `onStep` branches on `_analogEngine` to call `getNodeVoltage` vs `getSignalValue`.

**Target state**: Constructor takes `SimulationCoordinator` + `SignalDescriptor[]` where each descriptor carries a `SignalAddress`. Remove `_analogEngine` field and duck-type check entirely. `onStep` calls `coordinator.readSignal(addr)` uniformly:

```typescript
onStep(_stepCount: number): void {
  for (const row of this._rows) {
    const sv = this._coordinator.readSignal(row.descriptor.addr);
    row.value = sv.type === 'digital'
      ? BitVector.fromNumber(sv.value, row.descriptor.width)
      : sv.voltage;
  }
}
```

The `sv.type` check here is per-signal (discriminated union on the value), not whole-circuit.

### 4.3 SimulationRunner (`src/headless/runner.ts`)

- `runToStable()`: use `coordinator.signalCount` and `coordinator.snapshotSignals()`
- `dcOperatingPoint()`: use `coordinator.dcOperatingPoint()`
- Delete `_resolveBackendEngine()` and `_snapshotSignals()`

### 4.4 TestBridge (`src/app/test-bridge.ts`)

- Remove `AnalogTestContext` interface and `analogCtx` parameter from `createTestBridge`
- `getAnalogState()` uses `coordinator.readAllSignals()` and `coordinator.simTime`
- Rename `getEngineType()` → `getCircuitDomain()` (this is a circuit-model query, not a coordinator query)

### 4.5 WireCurrentResolver (`src/editor/wire-current-resolver.ts`)

**Current state**: `resolve(engine: AnalogEngine, circuit: Circuit, compiled: ResolvedAnalogCircuit)` — takes raw analog engine and compiled circuit. Called from app-init's analog render loop.

**Target state**: `resolve(ctx: CurrentResolverContext)` — takes the coordinator-provided context (see §1.10). The resolver no longer imports `AnalogEngine` or `ResolvedAnalogCircuit`. The `CurrentResolverContext` interface provides exactly the data it needs:
- `wireToNodeId` for wire→node mapping
- `elements` for element iteration
- `elementToCircuitElement` for position lookups
- `getElementPinCurrents(idx)` for current queries

App-init calls `coordinator.getCurrentResolverContext()` and passes the result to `resolver.resolve(ctx)`.

### 4.6 SliderEngineBridge (`src/editor/slider-engine-bridge.ts`)

**Current state**: `constructor(panel: SliderPanel, engine: AnalogEngine, compiled: CompiledAnalogCircuit)` — takes raw analog engine. Calls `engine.configure({})` to trigger re-stamp after parameter changes. Accesses `compiled.elements` via type cast.

**Target state**: `constructor(panel: SliderPanel, coordinator: SimulationCoordinator)`. On slider change:
1. Call `coordinator.setComponentProperty(element, key, value)` (see §1.7)
2. The coordinator internally calls `element.setParam()` + `engine.configure({})` — consumers never touch the engine.

Remove `AnalogEngine` and `CompiledAnalogCircuit` imports from this file.

### 4.7 AnalogScopePanel (`src/runtime/analog-scope-panel.ts`)

**Current state**: `constructor(canvas, engine: AnalogEngine)`. Channels use raw `nodeId`. `onStep` calls `engine.getNodeVoltage(nodeId)`, `engine.getElementCurrent(elementId)`, `engine.getBranchCurrent(branchId)`. Reads `engine.simTime` for X-axis.

**Target state**: `constructor(canvas, coordinator: SimulationCoordinator)`. Channel descriptors carry `SignalAddress` for voltage channels. `onStep` calls:
- `coordinator.readSignal(addr)` for voltage channels
- `coordinator.readElementCurrent(elementIndex)` for element current channels (see §1.8)
- `coordinator.readBranchCurrent(branchIndex)` for branch current channels (see §1.8)
- `coordinator.simTime` for X-axis (see §1.2)

Registers as `MeasurementObserver` on coordinator (already supported).

### 4.8 TimingDiagramPanel (`src/runtime/timing-diagram.ts`)

**Current state**: `constructor(canvas, engine: SimulationEngine, channels, opts)`. Channels use raw `netId`. `onStep` calls `engine.getSignalRaw(netId)`. Uses `engine.saveSnapshot()` / `engine.restoreSnapshot(id)` for time-cursor scrubbing.

**Target state**: `constructor(canvas, coordinator: SimulationCoordinator, channels, opts)`. Channel descriptors carry `SignalAddress`. `onStep` calls `coordinator.readSignal(addr)`. Snapshot management via `coordinator.saveSnapshot()` / `coordinator.restoreSnapshot(id)` (see §1.9).

Registers as `MeasurementObserver` on coordinator.

---

## 5. Wave Structure

### Wave 5b.1 — Coordinator Interface Expansion (no dependencies)

| Task | Title | Size |
|------|-------|------|
| P5b-1 | Add capability queries to SimulationCoordinator interface + implement (§1.1) | M |
| P5b-2 | Add unified execution methods: microStep, runToBreak, dcOp, acAnalysis, getState, simTime (§1.2) | M |
| P5b-3 | Add snapshotSignals() and signalCount (§1.3) | S |
| P5b-4 | Move speed control into coordinator: computeFrameSteps, adjustSpeed, parseSpeed, formatSpeed (§1.4) | M |
| P5b-5 | Move ClockManager into coordinator, add advanceClocks() (§1.5) | S |
| P5b-6 | Add visualization context: getPinVoltages, getWireAnalogNodeId, voltageRange, updateVoltageTracking (§1.6) | S |
| P5b-7 | Add slider context: getSliderProperties, setComponentProperty (§1.7) | S |
| P5b-8 | Add measurement signal reading: readElementCurrent, readBranchCurrent (§1.8) | S |
| P5b-9 | Add snapshot management: saveSnapshot, restoreSnapshot (§1.9) | S |
| P5b-10 | Add current resolver context: getCurrentResolverContext (§1.10) | S |
| P5b-11 | Narrow `compiled` accessor type to expose only unified maps + diagnostics (§1.11) | M |

### Wave 5b.2 — Consumer Migration (depends on Wave 5b.1)

| Task | Title | Size |
|------|-------|------|
| P5b-12 | DataTablePanel: take coordinator + SignalAddress descriptors, remove duck-type check (§4.2) | S |
| P5b-13 | AnalogScopePanel: take coordinator, use readSignal/readElementCurrent/readBranchCurrent (§4.7) | M |
| P5b-14 | TimingDiagramPanel: take coordinator, use readSignal + saveSnapshot/restoreSnapshot (§4.8) | M |
| P5b-15 | WireCurrentResolver: accept CurrentResolverContext instead of (engine, circuit, compiled) (§4.5) | M |
| P5b-16 | SliderEngineBridge: take coordinator, use setComponentProperty (§4.6) | S |
| P5b-17 | SimulationRunner: use coordinator.snapshotSignals/signalCount/dcOp, delete _resolveBackendEngine (§4.3) | S |
| P5b-18 | DefaultSimulatorFacade: remove _engineMode, getCompiled/getCompiledAnalog, _resolveBackendEngine, _snapshotSignals (§2) | M |
| P5b-19 | EditorBinding: remove engine property (§4.1) | S |
| P5b-20 | TestBridge: remove AnalogTestContext, use coordinator, rename getEngineType→getCircuitDomain (§4.4) | S |

### Wave 5b.3 — App-init Unification (depends on Wave 5b.2)

| Task | Title | Size |
|------|-------|------|
| P5b-21 | Merge render loops into single _startRenderLoop with computeFrameSteps (§3.2) | L |
| P5b-22 | Merge dual compileAndBind paths, eliminate compiled.analog reach-throughs (§3.4, §1.11) | M |
| P5b-23 | Unify button handlers (step/micro-step/run-to-break/stop) with capability queries (§3.4) | M |
| P5b-24 | Speed UI: use coordinator.formatSpeed/adjustSpeed (§3.5) | S |
| P5b-25 | Context menus: replace isAnalogMode with capability queries or component-model checks (§3.6, §3.8) | S |
| P5b-26 | Visualization: extract activate/update/deactivate using coordinator methods (§3.3) | M |
| P5b-27 | Wire viewer + rebuildViewers: unify via wireSignalMap/SignalAddress, use coordinator for panels (§3.9) | M |

### Wave 5b.4 — Cleanup and Verification (depends on Wave 5b.3)

| Task | Title | Size |
|------|-------|------|
| P5b-28 | Remove digitalBackend/analogBackend from SimulationCoordinator interface (§1.12) | S |
| P5b-29 | Grep verification (see §7 acceptance criteria) | S |
| P5b-30 | Full test suite verification + new coordinator capability/speed/snapshot tests | M |

---

## 6. Render Loop Migration Detail

### Why two loops exist today

- **Digital**: step N times per frame, N = `speedControl.speed * wallDt`. Each step is unitless.
- **Analog**: step until `analogEngine.simTime >= simTimeGoal`, bounded by `budgetMs` wall-clock. Each step advances `simTime` by variable `lastDt`. Also owns voltage tracker, current flow animator, slider panel.

### How to unify

**Step 1**: Move timing model selection into `computeFrameSteps()` on coordinator:
```
discrete   -> { steps: round(speed * wallDt), simTimeGoal: null, budgetMs: Infinity }
continuous -> { steps: 0, simTimeGoal: simTime + speed * wallDt, budgetMs: 12 }
mixed      -> same as continuous (analog timing dominates)
```

**Step 2**: Analog visualization becomes activation/deactivation pair — not a separate loop.

**Step 3**: Single RAF handle. Delete `analogRafHandle`.

### What this preserves

- Analog circuits get rate-controlled stepping (budget-limited)
- Digital circuits get speed-control stepping (steps/second)
- Voltage gradients, current flow animation, slider panel activate for analog
- Mixed circuits get continuous-time-dominant stepping
- Speed display shows appropriate units

---

## 7. Acceptance Criteria

### Structural

- Zero `isAnalogMode()` or equivalent whole-circuit mode check in consumer code
- Zero `analogBackend` / `digitalBackend` in `SimulationCoordinator` interface (kept as private on concrete class)
- Zero `_engineMode` field on facade
- Zero `getCompiled()` / `getCompiledAnalog()` dual accessors on facade
- Zero direct `analogEngine.getNodeVoltage()` or `engine.getSignalRaw()` in consumer code
- Zero `coordinator.compiled.analog` or `coordinator.compiled.digital` reach-throughs in consumer code
- Zero raw `AnalogEngine` or `SimulationEngine` parameters in runtime panel constructors (`DataTablePanel`, `AnalogScopePanel`, `TimingDiagramPanel`)
- Zero raw `AnalogEngine` parameter in `WireCurrentResolver.resolve()` or `SliderEngineBridge` constructor
- One render loop function, one RAF handle
- `compiled` accessor on `SimulationCoordinator` interface exposes only `wireSignalMap`, `labelSignalMap`, `diagnostics`

### Grep verification

All greps scoped to `src/ --include="*.ts"`, excluding `solver/`, `compile/`, `__tests__/`, `.d.ts`:

```bash
# Must return zero hits
grep -r "analogBackend\|digitalBackend" src/ --include="*.ts" | grep -v solver/ | grep -v compile/ | grep -v __tests__ | grep -v ".d.ts"
grep -r "isAnalogMode\|_engineMode" src/ --include="*.ts" | grep -v __tests__
grep -r "getCompiledAnalog\|getCompiled()" src/ --include="*.ts" | grep -v solver/ | grep -v compile/ | grep -v __tests__
grep -r "compiled\.analog\|compiled\.digital" src/ --include="*.ts" | grep -v solver/ | grep -v compile/ | grep -v __tests__
grep -r "engine\.getSignalRaw\|engine\.getNodeVoltage\|engine\.getElementCurrent\|engine\.getBranchCurrent" src/ --include="*.ts" | grep -v solver/ | grep -v __tests__
grep -r "AnalogEngine" src/runtime/ src/editor/wire-current-resolver.ts src/editor/slider-engine-bridge.ts src/app/ --include="*.ts" | grep -v __tests__
```

### Testing

- All existing tests pass (minus pre-existing submodule ENOENT failures)
- New tests for: coordinator capability queries, speed control (computeFrameSteps for discrete/continuous/mixed), snapshotSignals, saveSnapshot/restoreSnapshot, readElementCurrent, readBranchCurrent, getCurrentResolverContext, narrowed compiled accessor

---

## 8. Design Decision: Coordinator Size

The coordinator grows from ~490 to ~800 lines. This is justified because:
1. It is the ONE place allowed to know about domains
2. It delegates internally to `SpeedControl`, `AnalogRateController`, `ClockManager`, `VoltageRangeTracker` — it composes, not reimplements
3. Every new domain (thermal, RF) adds methods to coordinator, not branching to every consumer
4. The alternative (consumers branch on backends) is exactly what we're eliminating
