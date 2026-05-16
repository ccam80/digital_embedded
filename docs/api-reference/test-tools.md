# Test tools — API reference and decision guide

> Generated 2026-05-05. Companion: `engine-flow.md` (engine semantics — when does X exist).
> Source-of-truth files:
> - `src/solver/analog/__tests__/fixtures/build-fixture.ts:1-162`
> - `src/headless/default-facade.ts:1-427`
> - `src/solver/coordinator.ts:1-992`
> - `src/solver/coordinator-types.ts:49-437`
> - `src/solver/analog/analog-engine.ts` (selected ranges)
> - `src/core/analog-engine-interface.ts:1-492`
> - `src/core/engine-interface.ts:29-266`
> - `src/solver/analog/state-pool.ts:35-148`
> - `src/solver/analog/compiled-analog-circuit.ts:57-186`
> - `src/solver/analog/__tests__/harness/comparison-session.ts:1-2585`
> - `src/solver/analog/__tests__/harness/types.ts:1-1119`
> - `src/solver/analog/__tests__/harness/capture.ts:200-300`
> - `scripts/mcp/harness-tools.ts:1-783`

This document answers **"what API call do I use to assert X?"** For "when does X exist and what overwrites it?", see `engine-flow.md`.

## Table of contents

1. [Pick a tool — tiers, categories, decision flow](#1-pick-a-tool)
2. [Code templates per (category, tier)](#2-code-templates)
3. [T1 — `buildFixture`](#3-t1-buildfixture)
4. [T2 — `ComparisonSession.createSelfCompare`](#4-t2-self-compare)
5. [T3 — `ComparisonSession.create` and MCP tools](#5-t3-paired-comparison)
6. [Returned data shapes](#6-returned-data-shapes)
7. [Observability ladder — what each tier sees](#7-observability-ladder)
8. [`.dts` authoring](#8-dts-authoring)
9. [Banned patterns](#9-banned-patterns)

**Skim path** if you only need a worked example: jump to §2.
**Skim path** if you only need a method signature: §3 (T1) or §5 (T3).
**Skim path** before authoring a new test file: §1 → §7 → §2.

---

## 1. Pick a tool

### The three tiers

| Tier | Construction | What it gives you | Cost |
|---|---|---|---|
| **T1** | `buildFixture(opts)` | Step-boundary state only: node voltages, branch/pin currents, accepted `state0..state7`, convergence-log step records, limiting events, runtime diagnostics. No ngspice. | Cheap (single warm-start, no DLL). |
| **T2** | `ComparisonSession.createSelfCompare(opts)` | Per-NR-iteration capture into `IterationSnapshot` records: matrix entries, `preSolveRhs`, `state0/1/2` slot trios per iteration, `ag[7]`, limiting events, `noncon`. **Both sides are deep clones of digiTS — no ngspice.** Use when you need per-iteration data without a DLL. | Medium (per-iteration capture overhead). |
| **T3** | `ComparisonSession.create({ dtsPath, dllPath })` OR MCP `harness_*` | Everything T2 gives, paired bit-exact against an instrumented ngspice DLL on the same circuit. Every `ComparedValue.withinTol === (ours === ngspice)` (IEEE-754 identity). | Heavy (DLL load + parallel ngspice run + per-iter capture). |

### Single-tier-per-file rule

If any test in a file needs T2 or T3, every test in that file uses that tier — do not mix `buildFixture` and `ComparisonSession` constructions across tests within a single file. Within one test you may interleave assertions on the same session: setup is expensive, batch.

For T2/T3 files: open the session in `beforeAll`, reuse across tests in the `describe`, dispose in `afterAll`.

### The 9 canonical categories

These are the only assertion shapes a component test file should make. Anything else is out-of-canon — record the assertion intent and surface it for canon review rather than inventing a new shape.

| # | Category | Asserts | Capability gate | Sanctioned tier |
|---|---|---|---|---|
| 1 | Initialization | Post-warm-start `state0` slot values and node voltages at step 0 match what the component's `setup()` should produce | always (every analog component) | T1 |
| 2 | DC operating point | Converged DC node voltages, branch currents, pin currents, element power | always | T1 (analytical expected) **or** T3 (numerical against ngspice) |
| 3 | Transient response | State, voltages, currents, power evolving over time | always | **T3 only** — no analytical truth for arbitrary transients |
| 4 | Parameter hot-load | A param changed via `setComponentProperty` produces a new simulation behaviour | always | T1 |
| 5 | Stamp / matrix entries | Per-element matrix and RHS contributions are bit-exact at sample points | always | **T3 only** |
| 6 | Limiting events | `pnjlim` / `fetlim` / `devlim` fires correctly; `vBefore` / `vAfter` are right | `load()` calls a `*lim` function (BJT, diode, MOSFET, JFET, SCR, optocoupler, varactor) | T1 (own engine) **or** T3 (paired) |
| 7 | LTE rollback | When LTE rejects, `pool.state0` after rotation matches the previously-accepted state | component class declares `getLteTimestep` (fuse, memristor, NTC self-heating, varactor, comparator-rollback variants) | T1 |
| 8 | Breakpoints | `acceptStep`-registered breakpoints cause the timestep controller to land bit-exactly on that time | component declares `acceptStep` and registers breakpoints (PULSE, AC, switches, comparator, timer-555) | T1 |
| 9 | Bridge / digital interaction | Digital input → analog response and vice versa across cross-domain boundaries | component has digital pins (registered via `bridgeAdaptersByGroupId`) or has a `models.digital` entry | T1 |

### How to pick a tier from intent

```
Want to assert ...                              → Tier
─────────────────────────────────────────────────────
final node voltage / branch current             → T1
analytical DCOP closed-form value               → T1
hot-load behaviour change                       → T1
limiting event presence (own engine only)       → T1
LTE rollback step-boundary invariant            → T1
breakpoint landed at exact time                 → T1
bit-exact match against ngspice (any quantity)  → T3
matrix entry / RHS at a specific NR iteration   → T3 (or T2 self-compare for digiTS-only)
state1[X] vs state0[X] mid-iteration            → T3 (or T2)
limiting parity vs ngspice                      → T3
phase ordering / NR retry counting parity       → T3
LTE-proposed dt parity                          → T3
```

### Capability detection

Read the component's production source file (e.g. `src/components/semiconductors/bjt.ts`). Look for:

- Calls to `pnjlim`, `fetlim`, `devlim`, or any `*lim` ngspice-mirror function inside `load()` → category 6 applies.
- A `getLteTimestep` method on the element class → category 7 applies.
- An `acceptStep` method that calls `addBPTop(...)` or sets `breakFlagTop` → category 8 applies.
- Digital pins on the `ComponentDefinition` → category 9 applies.

Categories 1–5 always apply.

---

## 2. Code templates

Copy-paste structural templates per (category, tier). Pick the one that matches your category and tier; substitute circuit topology and parameter values.

### Category 1 — Initialization (T1)

```ts
import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { DIODE_SCHEMA } from "../diode.js";

const SLOT_VD = DIODE_SCHEMA.indexOf.get("VD")!;

it("category_1_initial_state_after_warm_start", () => {
  const fix = buildFixture({
    build: (_reg, facade) => facade.build({
      components: [
        { type: "DCVoltageSource", label: "V1", props: { voltage: 0.7 } },
        { type: "Diode", label: "D1", props: { is: 1e-14 } },
      ],
      connections: [
        { from: "V1:pos", to: "D1:A" },
        { from: "V1:neg", to: "D1:K" },
      ],
    }),
  });

  const idx = fix.circuit.elements.findIndex(el => fix.elementLabels.get(el.index) === "D1");
  const el = fix.circuit.elements[idx];
  expect(fix.pool.state0[el._stateBase + SLOT_VD]).toBeCloseTo(0.7, 6);
  expect(fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!)).toBeCloseTo(0.7);
});
```

### Category 2 — DC operating point (T1, analytical)

```ts
it("category_2_dcop_voltage_divider", () => {
  const fix = buildFixture({ build: (_r, f) => f.build({ /* ... */ }) });
  const result = fix.coordinator.dcOperatingPoint();
  expect(result.converged).toBe(true);
  expect(result.method).toBe("direct");
  expect(fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("R1:b")!)).toBeCloseTo(2.5, 9);
});
```

### Category 2 — DC operating point (T3, numerical)

```ts
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import path from "node:path";

const DTS = path.resolve("src/components/semiconductors/__tests__/fixtures/bjt-canon-dcop.dts");
const DLL = process.env.NGSPICE_DLL_PATH ?? "ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll";

let session: ComparisonSession;
beforeAll(async () => {
  session = await ComparisonSession.create({ dtsPath: DTS, dllPath: DLL });
  await session.runDcOp();
});
afterAll(() => session?.dispose());

it("category_2_dcop_paired", () => {
  const stepEnd = session.getStepEnd(0);
  expect(stepEnd.nodes["R1:pos"].withinTol).toBe(true);
  expect(stepEnd.components["Q1"].slots["VBE"].withinTol).toBe(true);
});
```

### Category 3 — Transient response (T3)

```ts
beforeAll(async () => {
  session = await ComparisonSession.create({ dtsPath: DTS, dllPath: DLL });
  await session.runTransient(0, 50e-3, 1e-3);
});

it("category_3_transient_paired", () => {
  const stepIdx = session.getStepAtTime(20e-3, "ours")!;
  const stepEnd = session.getStepEnd(stepIdx);
  expect(stepEnd.nodes["OUT"].withinTol).toBe(true);
});
```

### Category 4 — Parameter hot-load (T1)

```ts
it("category_4_hot_load_resistance_changes_voltage", () => {
  const fix = buildFixture({ build: ... });
  const elt = fix.coordinator.compiled.allCircuitElements.find(e => e.label === "R1")!;
  const before = fix.engine.getNodeVoltage(nodeId);
  fix.coordinator.setComponentProperty(elt, "resistance", 2000);
  fix.coordinator.step();
  const after = fix.engine.getNodeVoltage(nodeId);
  expect(after).not.toBeCloseTo(before);
  expect(after).toBeCloseTo(expectedAfter, 6);
});
```

Assert on simulation outputs, never on private element fields or PropertyBag contents.

### Category 5 — Stamp / matrix entries (T3)

Two scripted sample points: cold (iter 0 of step 0, `ag[1] === 0`) and mature (iter 0 of a step at `simTime ≈ 50ms`, `ag[1] !== 0`).

```ts
beforeAll(async () => {
  session = await ComparisonSession.create({ dtsPath: DTS, dllPath: DLL });
  await session.runTransient(0, 50e-3, 1e-3);
});

it("category_5_stamp_bit_exact_cold", () => {
  const m = session.getMatrixLabeled(0, 0);
  for (const e of m.entries) expect(e.withinTol).toBe(true);
  const r = session.getRhsLabeled(0, 0);
  for (const row of r.entries) expect(row.withinTol).toBe(true);
});

it("category_5_stamp_bit_exact_mature", () => {
  const stepIdx = session.getStepAtTime(50e-3, "ours")!;
  const m = session.getMatrixLabeled(stepIdx, 0);
  for (const e of m.entries) expect(e.withinTol).toBe(true);
});
```

If category 3 transient parity already covers the property, skip the per-component stamp test — don't double-cover.

### Category 6 — Limiting events (T1, own engine)

```ts
it("category_6_limiting_pnjlim_fires_dcop", () => {
  const fix = buildFixture({ build: ... });
  fix.coordinator.setLimitingCapture(true);
  fix.coordinator.dcOperatingPoint();
  const events = fix.coordinator.getLimitingEvents();
  const vbe = events.find(e => e.label === "Q1" && e.junction === "VBE");
  expect(vbe).toBeDefined();
  expect(vbe!.wasLimited).toBe(true);
});
```

### Category 6 — Limiting events (T3, paired)

```ts
it("category_6_limiting_paired", () => {
  const cmp = session.getLimitingComparison("Q1", 0, 1 /* iterIdx */);
  for (const j of cmp.junctions) expect(j.limitingDiff).toBe(0);
});
```

### Category 7 — LTE rollback (T1)

```ts
it("category_7_lte_rollback_state_invariant", () => {
  const fix = buildFixture({ build: <topology that triggers LTE rejection> });
  fix.coordinator.setConvergenceLogEnabled(true);
  for (let i = 0; i < N; i++) fix.coordinator.step();

  const log = fix.coordinator.getConvergenceLog()!;
  const rejected = log.find(s => s.lteRejected === true);
  expect(rejected).toBeDefined();

  const slot = MEMRISTOR_SCHEMA.indexOf.get("Q")!;
  expect(fix.pool.state0[el._stateBase + slot])
    .toBe(fix.pool.state1[el._stateBase + slot]);
});
```

This is the only canonical T1 test where reading both `pool.state0` and `pool.state1` directly is sanctioned — the assertion is on the rotation invariant, not mid-iteration state.

### Category 8 — Breakpoints (T1)

```ts
it("category_8_pulse_breakpoint_lands_exactly", () => {
  const T_BP = 1e-3; // pulse rising edge
  const fix = buildFixture({
    build: <PULSE source with td = T_BP>,
    params: { tStop: T_BP * 2 },
  });
  fix.coordinator.setConvergenceLogEnabled(true);
  while (fix.engine.simTime < T_BP * 1.5) fix.coordinator.step();

  const log = fix.coordinator.getConvergenceLog()!;
  const bpStep = log.find(s => s.endTime === T_BP);
  expect(bpStep).toBeDefined();
});
```

### Category 9 — Bridge / digital interaction (T1)

```ts
it("category_9_dac_digital_input_drives_analog_output", () => {
  const fix = buildFixture({ build: ... });
  fix.coordinator.writeByLabel("D0", 1);
  fix.coordinator.step();
  const v = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("DAC1:OUT")!);
  expect(v).toBeCloseTo(1.65, 3);

  // Reverse direction
  fix.coordinator.setSourceByLabel("vin", "voltage", 3.3);
  fix.coordinator.step();
  expect((fix.coordinator.readByLabel("CMP1:OUT") as { value: number }).value).toBe(1);
});
```

---

## 3. T1 — `buildFixture`

### Entry point

```ts
function buildFixture(opts: FixtureOptions): Fixture
```

`FixtureOptions` (`build-fixture.ts:30-52`):

| Field | Type | Notes |
|---|---|---|
| `dtsPath?` | `string` | Path to `.dts` JSON, resolved relative to CWD when not absolute. **Mutually exclusive** with `build`. |
| `build?` | `(registry, facade) => Circuit` | Programmatic builder. **Mutually exclusive** with `dtsPath`. |
| `params?` | `Partial<SimulationParams>` | Applied via `engine.configure(params)` AFTER `compile()` and BEFORE the warm-start step. |

`Fixture`:

```ts
interface Fixture {
  readonly facade: DefaultSimulatorFacade;
  readonly coordinator: DefaultSimulationCoordinator;
  readonly engine: MNAEngine;
  readonly pool: StatePool;
  readonly circuit: ConcreteCompiledAnalogCircuit;
  readonly elementLabels: ReadonlyMap<number, string>;
}
```

Side effects, in order (`build-fixture.ts:64-139`):

1. Fresh registry + `DefaultSimulatorFacade`.
2. Load circuit from `dtsPath` or `opts.build`.
3. `facade.compile(circuit)` — disposes any prior engine, produces `DefaultSimulationCoordinator`.
4. Get `coordinator.getAnalogEngine()`, assert `MNAEngine`.
5. If `params`, call `engine.configure(params)`.
6. **One `coordinator.step()`** — drives the canonical warm-start: `_setup()` → `_transientDcop()` → first transient timestep.
7. Read `engine.compiled` (asserted non-null) and `compiled.statePool` (asserted non-null).
8. Build `elementLabels` via `buildElementLabels(compiled)`.

There is no `skipBoot` mode. The warm-start always runs.

Throws on: empty circuit, digital-only circuit, non-MNA analog backend, both/neither of `build`/`dtsPath`. See `engine-flow.md` §3 for what the warm-start writes.

### `facade: DefaultSimulatorFacade`

Composes `CircuitBuilder` and `SimulationLoader`. After `buildFixture`, `facade.getActiveCoordinator() === fixture.coordinator`. Source: `src/headless/default-facade.ts`.

| Method | Returns / mutates | Use when |
|---|---|---|
| `createCircuit(opts?)` | New empty `Circuit`. | Constructing a second circuit alongside the fixture's. |
| `addComponent(circuit, type, props?)` | Returns `CircuitElement`; mutates `circuit`. | Inside `opts.build`. |
| `connect(circuit, src, srcPin, dst, dstPin)` | Returns `Wire`; mutates `circuit`. | Inside `opts.build`. |
| `build(spec)` | Returns `Circuit` from declarative `CircuitSpec`. | Most concise way to construct a fixture circuit. |
| `patch(circuit, ops, opts?)` | Returns `PatchResult`; mutates `circuit`. **Stales `fixture.coordinator/engine/pool/circuit` until you re-`compile()`.** | Editing a loaded circuit. |
| `setCaptureHook(bundle \| null)` | Installs `coordinator.applyCaptureHook`; forces `detailedConvergence=true`, `convergenceLog.enabled=true`, `limitingCollector=[]`. | Per-NR-iter capture. Pass `null` to clear. **`setConvergenceLogEnabled(false)` throws while a hook is installed.** |
| `compile(circuit)` | Returns `DefaultSimulationCoordinator`; disposes the prior pair, re-installs any prior capture hook. **Always fresh engine.** | Recompiling after `patch`. |
| `step(coordinator, opts?)` | Mutates: advances simulation. Default does `advanceClocks()` then `coordinator.step()`. Pass `{clockAdvance:false}` to skip. | Driving extra transient steps post-warm-start. |
| `run(coordinator, cycles, opts?)` | Calls `step()` `cycles` times. | Bulk step driving. |
| `stepToTime(coordinator, t, budgetMs?)` | Async; returns step count. Adds breakpoint at `t`, steps until reached or budget. Yields every ~12ms (`FRAME_BUDGET_MS`). | Landing on a specific simTime. |
| `sampleAtTimes<T>(coordinator, times, capture, budgetMs?)` | Async; returns `T[]`. Throws on non-monotonic times or budget exceeded. | Sampling at multiple times. |
| `settle(coordinator, settleTime?)` | Async. If `simTime===null`, one no-clock-advance step; else advances by `settleTime` (default 0.01s). | Letting an analog circuit reach steady state. |
| `setSignal(coordinator, label, value)` | Routes analog labels via `setSourceByLabel`, digital via `writeSignal`. Throws `FacadeError` on unknown label. | Driving an input. |
| `readSignal(coordinator, label)` | Returns digital `value` or analog `voltage` based on label domain. | Reading an output. |
| `readAllSignals(coordinator)` | `Record<string, number>` of every label. | Snapshot. |
| `runTests(coordinator, circuit, testData?)` | Async; returns `TestResults`. Auto-extracts embedded `Testcase` when `testData` omitted. | Running test vectors. |
| `loadDigXml(xml)` | Returns `Circuit` from `.dig` XML (legacy). | Legacy fixtures. |
| `serialize(circuit)` / `deserialize(json)` | `.dts` JSON in/out. | Persistence. |
| `importSubcircuit(circuit, name, content, resolver?)` | Async; registers subcircuit in `circuit.metadata.subcircuits`. | Subcircuit support. |
| `netlist(circuit)` | Read-only `Netlist` (pre-compile introspection). | Inspection. |
| `validate(circuit)` | `Diagnostic[]` (pre-compile). | Validation. |
| `describeComponent(typeName)` | `ComponentDefinition \| undefined`. | Registry lookup. |
| `getCoordinator()` | The active coordinator (`NullSimulationCoordinator` before any compile). | Never null. |
| `getActiveCoordinator()` | `DefaultSimulationCoordinator \| null`. | Identity-equal to `fixture.coordinator` after `buildFixture`. |
| `getCircuit()` | Source `Circuit` last passed to `compile()`. **NOT** `ConcreteCompiledAnalogCircuit` — that's `fixture.circuit`. | Visual model access. |
| `getCompiledUnified()` | `CompiledCircuitUnified \| null` — full unified compiled output. | Cross-domain access. |
| `getDcOpResult()` | Fresh `DcOpResult` by re-running `coordinator.dcOperatingPoint()`. **Resets `analysisPhase` to `"dcop"`.** | DCOP without manually calling coordinator. |
| `setConvergenceLogEnabled(enabled)` | Toggles `engine.convergenceLog.enabled`. Throws if hook installed and `enabled===false`. | See `engine-flow.md` §6. |
| `getConvergenceLog(lastN?)` | `StepRecord[] \| null`. | Inspecting per-step retry/LTE history. |
| `clearConvergenceLog()` | Drains the engine's ring buffer. | Between scenarios in one test. |
| `invalidate()` | Disposes coordinator; resets to `NullSimulationCoordinator`. | Cleanup. |

### `coordinator: DefaultSimulationCoordinator`

Implements `SimulationCoordinator` (`coordinator-types.ts:49-385`). The fixture types `coordinator` as concrete, so accesses below need no cast at the fixture boundary. **At any other test boundary that holds the interface, casting to access concrete-only members is treated as a banned pattern.**

#### Interface members (sanctioned)

| Method | Signature | Notes |
|---|---|---|
| `step()` | `void` | One step across all backends. Throws on stagnation. |
| `start()` / `stop()` | `void` | Backend lifecycle. |
| `reset()` | `void` | Resets backends, clears bridge state, `_stepCount`, voltage tracking, analysis phase. Warm-start re-runs on next `step()`. |
| `dispose()` | `void` | Disposes both backends. |
| `readSignal(addr)` / `writeSignal(addr, v)` | `SignalAddress` → `SignalValue` | Domain-polymorphic. |
| `readByLabel(label)` / `writeByLabel(label, v)` | Label-keyed. Throws `FacadeError` on unknown label. |
| `readAllSignals()` | `Map<string, SignalValue>` | Snapshot. |
| `compiled` | Domain-agnostic view: `wireSignalMap`, `labelSignalMap`, `labelToCircuitElement`, `pinSignalMap`, `diagnostics`. **Concrete getter widens to full `CompiledCircuitUnified`.** |
| `getRuntimeDiagnostics()` | `readonly Diagnostic[]` | Engine runtime collector — distinct from `compiled.diagnostics` (compile-time). |
| `addMeasurementObserver` / `removeMeasurementObserver` | Per-step / on-reset notifications. |
| `supportsMicroStep` / `supportsRunToBreak` / `supportsAcSweep` / `supportsDcOp` / `supportsConvergenceLog` | Capability queries. |
| `microStep()` / `runToBreak()` | Digital-only. No-op without digital. |
| `dcOperatingPoint()` | `DcOpResult \| null` | Resets `analysisPhase` to `"dcop"`. **Not a transient warm-up** — see `engine-flow.md` §7. |
| `acAnalysis(params)` | `AcResult \| null` | Relinearises at DC then sweeps. |
| `applyCaptureHook(bundle \| null)` | Same semantics as `facade.setCaptureHook`. |
| `getElementLabel(idx)` | `${label} (${typeId}) \| undefined`. |
| `setConvergenceLogEnabled(enabled)` | Throws if hook installed and `enabled===false`. |
| `getConvergenceLog(lastN?)` / `clearConvergenceLog()` | `StepRecord[] \| null`. |
| `stepToTime(t, budgetMs?)` | Async breakpoint-driven stepping. |
| `sampleAtTimes<T>(times, capture, budgetMs?)` | Async; throws on non-monotonic. |
| `simTime` | `number \| null` (null for digital-only). |
| `setSimTime(t)` | Sets `engine.simTime` and `_simTimeTarget`. |
| `setSnapshotBudget(bytes)` | Digital-only. |
| `getState()` | `EngineState` — unified across backends. |
| `snapshotSignals()` | Fresh `Float64Array` of length `signalCount`. Digital nets [0, digitalNetCount), then analog nodes 1..nodeCount. |
| `signalCount` / `timingModel` | Counts and `'discrete' \| 'continuous' \| 'mixed'`. |
| `computeFrameSteps(wallDt)` / `syncTimeTarget()` / `addTimeBreakpoint(t)` | Frame budgeting + breakpoint forwarding. |
| `speed` (get/set) / `adjustSpeed` / `parseSpeed` / `formatSpeed` | Speed control. |
| `advanceClocks()` | Digital clock signal advancement. No-op without digital. |
| `getPinVoltages(element)` | `Map<pinLabel, voltage> \| null`. **Reuses one internal Map per call** — invalidated by next call. |
| `getWireAnalogNodeId(wire)` | MNA node ID or undefined. |
| `voltageRange` | Tracked extrema since last reset; null without analog. |
| `updateVoltageTracking()` | Extends tracking. |
| `getSliderProperties(element)` | `SliderPropertyDescriptor[]` for FLOAT properties. |
| `setComponentProperty(element, key, value)` | Hot-patches a param. Routes digital via `layout.setProperty`, analog via `el.setParam` + `engine.configure({})`. Composite `A.rOut` keys route to bridge adapters by suffix. |
| `setSourceByLabel(label, paramKey, value)` | Resolves label, infers `paramKey` from registry's `behavioral` `paramDef` if empty. Silent no-op for unknown labels. |
| `readElementCurrent(elementIdx)` / `readBranchCurrent(branchIdx)` / `readElementPower(elementIdx)` | First-pin / branch-row / instantaneous V·I. Null without analog. |
| `saveSnapshot()` / `restoreSnapshot(id)` | Digital-only. |
| `getCurrentResolverContext()` | Wire-current lookup bundle. |
| `setLimitingCapture(enabled)` | Sets `engine.limitingCollector = []` or `null`. |
| `getLimitingEvents()` | Current `engine.limitingCollector` (or frozen empty array). |

#### Concrete-only on `DefaultSimulationCoordinator`

The fixture's `coordinator` is concrete-typed, so these are reachable directly via `fixture.coordinator.X`.

| Member | Returns |
|---|---|
| `compiled` (concrete getter widens) | Full `CompiledCircuitUnified` — adds `digital`, `analog`, `bridges`, `allCircuitElements`. |
| `getDigitalEngine()` / `getAnalogEngine()` | Internal engine refs. |
| `analysisPhase` | `'dcop' \| 'tranInit' \| 'tranFloat'`. |
| `setDiagnosticCollector(collector)` | Replaces runtime diagnostic collector. |

### `engine: MNAEngine`

Implements `AnalogEngine extends Engine`. Source: `src/solver/analog/analog-engine.ts`.

#### Interface members (`AnalogEngine`)

| Method | Notes |
|---|---|
| `init(circuit)` | Already called by coordinator before warm-start. |
| `reset()` / `dispose()` / `start()` / `stop()` | `reset()` zeroes `ctx.rhs/rhsOld`, resets `StatePool`, re-runs `initState()` on every pool-backed element, clears diagnostics and convergence log. |
| `step()` | First call after init/reset runs `_setup()` then `_transientDcop()` warm-start before the transient body. |
| `getState()` | `EngineState`. ERROR on unrecoverable convergence failure. |
| `addChangeListener` / `removeChangeListener` | Engine state transitions. |
| `dcOperatingPoint()` | `DcOpResult` (`{converged, method, iterations, nodeVoltages, diagnostics}`). |
| `acAnalysis(params)` | `AcResult`. |
| `simTime` (read-only) / `setSimTime(t)` | Propagates to `compiled.timeRef.value`. |
| `lastDt` (read-only) | Most recent accepted timestep. |
| `getNodeVoltage(nodeId)` | Reads `_ctx.rhs[nodeId]` (1-based; 0 → 0). |
| `setNodeVoltage(nodeId, v)` | Writes both `rhs` and `rhsOld`. |
| `getBranchCurrent(branchId)` | `nodeCount + 1 + branchId` slot. |
| `getElementCurrent(elementId)` | First-pin current. |
| `getElementPinCurrents(elementId)` | Per-pin (positive = into element; sums to zero by KCL). |
| `getElementPower(elementId)` | Instantaneous V·I summed across pins. |
| `configure(params)` | Merges into `_params` with ngspice-correct re-derivation of `firstStep`/`minTimeStep`, refreshes ctx tolerances, propagates `MODEUIC`, reseeds breakpoints if `tStop` changed. |
| `onDiagnostic(callback)` | Per-diagnostic callback. |
| `convergenceLog` (read-only) | `ConvergenceLog`: `enabled`, `record(step)`, `getAll()`, `getLast(n)`, `clear()`. |
| `addBreakpoint(t)` / `clearBreakpoints()` | Forwards to `_timestep`. |
| `addMeasurementObserver` / `removeMeasurementObserver` | Per-step / on-reset. |

#### Concrete-only on `MNAEngine`

| Member | Returns |
|---|---|
| `matrixSize` | `_solver.matrixSize` after `_setup()`. 0 before init. |
| `integrationOrder` | 1 (backward Euler) or 2 (trapezoidal/gear-2). |
| `cktContext` | `CKTCircuitContext \| null` — pre-allocated NR/DCOP context. |
| `currentDt` | Timestep proposed for next step. |
| `integrationMethod` | `'trapezoidal' \| 'gear' \| ...`. |
| `timestepDeltaOld` | Read-only view of `ctx.deltaOld[]` (length 7). |
| `getLteNextDt()` | Most recent LTE-driven proposed dt. |
| `solver` | `SparseSolver \| null`. |
| `statePool` | `compiled.statePool`. Identity-equal to `fixture.pool`. |
| `elements` | `readonly AnalogElement[]`. Identity-equal to `fixture.circuit.elements`. |
| `compiled` | Identity-equal to `fixture.circuit`. |
| `getNodeTable()` | `${name, number, type}[]` — internal nodes only (pin nodes 1..nodeCount NOT included). |
| `getDiagnostics()` | Same data as `coordinator.getRuntimeDiagnostics()`. |
| `postIterationHook` / `preFactorHook` / `stepPhaseHook` | Capture hook fields (assignable). |
| `detailedConvergence` (boolean) / `limitingCollector` (`LimitingEvent[] \| null`) | Capture flags. |

### `pool: StatePool`

Source: `src/solver/analog/state-pool.ts:35-148`. Ring of 8 `Float64Array`s; slots `0..maxOrder+1` rotate at each accepted step. Identity-equal to `fixture.engine.statePool` and `fixture.circuit.statePool`.

| Property / method | Notes |
|---|---|
| `states: Float64Array[]` (length 8) | Each array length `pool.totalSlots`. |
| `state0` / `state1` / ... / `state7` (getters) | Indices into `states`. `state0` = current iter; `state1` = previously accepted. |
| `totalSlots` | Sum of every element's pool footprint via `stateSchema`. |
| `tranStep` | Accepted-transient-step count. After warm-start, normally 1. |
| `dt` | Integration timestep (engine writes before each stamp pass). 0 during DCOP. |
| `temperature` | Kelvin (default 300.15). Maps to ngspice `CKTtemp`. |
| `maxOrder` | Default 2 (trapezoidal). Bounds the rotation ring. |
| `rotateStateVectors()` | Pointer-rotates `states[0..maxOrder+1]`. Mirrors ngspice `dctran.c:719-723`. |
| `reset()` | Zeroes all state arrays; resets `tranStep` and `dt`. |
| `copyState1ToState23()` | Copies `state1` into `state2` and `state3` (firsttime seeding, `dctran.c:795-799`). |

### Reading element state via the pool

Per `feedback_schema_lookups_over_exports`: resolve slot indices via the schema, never import raw `SLOT_*` constants from production source.

```ts
import { DIODE_SCHEMA } from "../diode.js";
const SLOT_VD = DIODE_SCHEMA.indexOf.get("VD")!;
const v = fix.pool.state0[el._stateBase + SLOT_VD];
```

### `circuit: ConcreteCompiledAnalogCircuit`

Source: `src/solver/analog/compiled-analog-circuit.ts:57-186`. Implements `CompiledAnalogCircuit extends CompiledCircuit`. Identity-equal to `fixture.engine.compiled`.

#### Interface members (`CompiledAnalogCircuit`)

| Property | Notes |
|---|---|
| `nodeCount` | Non-ground MNA nodes (IDs 1..nodeCount). |
| `elementCount` | `elements.length`. |
| `labelToNodeId: Map<string, number>` | First-pin semantics for multi-pin elements. |
| `wireToNodeId: Map<Wire, number>` | Wire → MNA node. |
| `statePool` | Identity-equal to `fixture.pool` post-warm-start. |
| `nodesets?` / `ics?` | NR initJct/initFix constraints. |
| `bridgeAdaptersByGroupId` | Cross-domain adapters keyed by `boundaryGroupId`. |

#### Concrete-only members

| Property | Notes |
|---|---|
| `elements: AnalogElement[]` | Stamping order (sorted by `NGSPICE_LOAD_ORDER`). |
| `labelPinNodes` | Label → full pin list with node IDs. 1-pin components have a bare label entry. |
| `models: Map<string, DeviceModel>` | Currently empty (placeholder). |
| `elementToCircuitElement` | Element index → visual `CircuitElement`. |
| `elementPinVertices` / `elementResolvedPins` | Pin geometry / resolved pin records. |
| `groupToNodeId` | Connectivity-group ID → MNA node (zero-wire groups). |
| `elementBridgeAdapters` | Per-element bridge adapters. |
| `diagnostics` | Compile-time diagnostics (distinct from runtime). |
| `timeRef: { value: number }` | Engine writes `simTime` before each stamp pass. |

### `elementLabels: ReadonlyMap<number, string>`

Built once in `buildFixture()` post-warm-start. Preference order:

1. `el.getProperties().getOrDefault<string>("label", "")` if non-empty.
2. `CircuitElement.instanceId` if registered.
3. `AnalogElement.label` if non-empty.
4. `element_${i}` positional fallback.

Snapshot — stale if a test mutates labels after fixture construction.

---

## 4. T2 — self-compare

Use `ComparisonSession.createSelfCompare` when you need per-NR-iteration data but no ngspice DLL is available (or you only want to assert digiTS-side per-iter properties without parity).

```ts
static async ComparisonSession.createSelfCompare(opts: {
  dtsPath?: string;
  buildCircuit?: (registry: ComponentRegistry) => Circuit;
  analysis: "dcop" | "tran";
  tStop?: number;            // required when analysis === "tran"
  maxStep?: number;          // optional cap on transient step
  params?: Partial<SimulationParams>;
}): Promise<ComparisonSession>
```

Behaviour: deep-clones our digiTS side as the ngspice side. **The DLL is not opened.** Every `ComparedValue.withinTol` is trivially `true` (deep-clone identity). Use this mode to:

- Exercise the per-iteration capture pipeline without a DLL host.
- Assert structural properties of digiTS-side iterations (`matrix.length === N²`, `noncon === 0`, etc.).
- Stage tests that will become T3 once a `.dts` and DLL are wired.

All query methods (`sessionMap`, `getStep`, `getAttempt`, `getStepEnd`, `getIterations`, `getStateHistory`, etc.) work the same way as in T3 — see §5.

---

## 5. T3 — paired comparison

### Construction

```ts
new ComparisonSession({
  dtsPath: string,                       // required (or supplied via createSelfCompare)
  cirPath?: string,                      // hand-written .cir; otherwise auto-generated from compiled circuit
  dllPath?: string,                      // default: process.env.NGSPICE_DLL_PATH ?? "ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll"
  maxOurSteps?: number,                  // default 5000
  selfCompare?: boolean,                 // true → DLL not loaded, ngspice side is a clone
});

// Convenience
ComparisonSession.create(opts) === new + await init();
ComparisonSession.createSelfCompare(opts);  // see §4
```

### Lifecycle

| Method | Purpose |
|---|---|
| `await session.init()` | Compile circuit, install per-iter capture hook, generate or read SPICE netlist. **No analysis runs here.** |
| `await session.runDcOp()` | Standalone DC op. Captures step 0 with `_stepCapture.endStep`. Then runs ngspice via the bridge, builds node mapping, asserts matrix structural parity (hard-fails on `matrixSize` mismatch). Idempotent (no-op if `_hasRun`). |
| `await session.runTransient(tStart, tStop, maxStep?)` | Transient. Loops `_coordinator.step()` up to `maxOurSteps`. Captures attempts via the hook; closes each step with `lastDt` (not `currentDt`) and the LTE-proposed `nextDt`. ngspice runs after our side completes. Removes the capture hook at exit. Boot step (firsttime DCOP) recorded inside step 0 alongside the first `tranInit` attempt. |
| `session.dispose()` | Drops capture sessions, comparisons, node map. Idempotent. |
| `session.errors` | `string[]` populated on ngspice exceptions or no-progress detection. |

### Query methods

| Method | Returns | Use when |
|---|---|---|
| `sessionMap()` | `SessionMap` (lightweight per-step shape rows for both sides; no iteration data) | Discovery: how many steps, what attempts each step ran. |
| `getStep({index} \| {time, side?})` | `StepDetail` (paired attempts, pairing rows, `dt`, times as `ComparedValue`s) | One step's attempt-level summary. |
| `getAttempt({stepIndex, phase, phaseAttemptIndex, iterationRange?, offset?, limit?})` | `AttemptDetail` (paired per-iteration data) | The richest method. Per-NR-iter matrix, RHS, residual, state0/1/2, ag, limiting events, convergence flags. |
| `getStepEnd(stepIndex, opts?)` | `StepEndReport` (converged voltages, branches, per-component slots from both sides at the accepted attempt's final iteration) | Step-end value parity. |
| `getStepEndRange(start, end)` | `StepEndReport[]` over inclusive range | Bulk step-end. |
| `getIterations(stepIndex)` | `IterationReport[]` for the **accepted** attempt only | Per-iter state0 / nodes / matrix diff for the accepted path. (For non-accepted attempts use `getAttempt`.) |
| `getStateHistory(label, stepIndex)` | `state0/1/2` slot trios on both sides for one element at one step's accepted final iter | LTE / temperature / charge state diagnosis. |
| `getComponentSlots(label, patterns, opts?)` | Snapshot (when `opts.step` provided) or trace (all steps) | Glob-matched per-component slot query. `*` = all. |
| `getDivergences(opts?)` | `DivergenceReport` filtered to `withinTol === false` entries | Categories: `voltage`, `state`, `rhs`, `matrix`, `shape`. |
| `getMatrixLabeled(stepIndex, iter)` | `LabeledMatrix` with per-entry `entryKind` (`both`, `engineSpecific`, `captureMissing`) | Stamp parity. |
| `compareMatrixAt(stepIndex, iter, filter)` | Filtered `getMatrixLabeled` (`"all"` or `"mismatches"`) | Quick mismatch-only view. |
| `getRhsLabeled(stepIndex, iter)` | `RhsLabeledResult` (per-row pre-solve RHS) | Stamp source-term parity. |
| `getIntegrationCoefficients(stepIndex)` | Step-level `ag0` / `ag1` / `method` / `order` for both sides | Integration-method parity. |
| `getLimitingComparison(label, stepIndex, iter)` | `LimitingComparisonReport` per-junction `vBefore`/`vAfter`/`wasLimited` | Junction limiting parity. |
| `getConvergenceDetail(stepIndex, iter)` | Per-element `converged` flag pair | Convergence attribution. |
| `getSummary()` | `SessionSummary` (one-shot aggregate) | First-divergence locator. |
| `getSessionShape()` / `getStepShape(stepIndex)` | Older shape descriptors (predate `sessionMap`) | Legacy. |
| `getStepAtTime(t, side?)` | Step index whose `[start, end)` brackets `t`; null past last `stepEndTime` | Transient time-to-step lookup. |
| `listComponents(opts?)` / `listNodes(opts?)` | Element / node inventory | Discovery. |
| `getComponentsByType(type)` | Filtered `listComponents` | Type-specific iteration. |
| `toJSON(opts?)` | `SessionReport` JSON. `opts.includeAllSteps` toggles divergence-only vs all. | Offline diff. |

### Public getters

| Getter | Returns |
|---|---|
| `ourSession` | Unaligned digiTS `CaptureSession`. |
| `ngspiceSession` | Raw ngspice snapshot in ngspice node ordering. |
| `ngspiceSessionAligned` | ngspice snapshot reindexed to digiTS node ordering. |
| `nodeMap` | `NodeMapping[]`. |
| `ourTopology` | `TopologySnapshot` after most recent run. |
| `engine` | Wrapped `MNAEngine`. |
| `getNgspiceDeck(opts?)` | The SPICE deck as fed to `NgspiceBridge.loadNetlist`. See below. |

Tests can walk these directly when query methods don't expose what's needed (e.g. `session.ourSession!.steps[i].attempts[j].iterations[k]`).

#### `getNgspiceDeck(opts?: { raw?: boolean }): string`

Returns the exact text passed to ngspice for the current session.

| Session mode | `getNgspiceDeck()` returns |
|---|---|
| `cirPath` supplied | The .cir contents with the `.control` block stripped (the harness drives ngspice imperatively, not via netlist commands). Author owns `.options TEMP`. |
| Auto-generated (no `cirPath`) | `generateSpiceNetlist(compiled, registry, elementLabels)` output, with `.options TEMP=<celsius>` injected after the title line when `engine.circuitTemp` differs from ngspice's 300.15 K default. |
| `selfCompare: true` | `""` (no ngspice side). |

Must be called after `init()`. Pass `{ raw: true }` to get `_cirClean` (pre-`_materializeCir()` form, no TEMP injection) — useful for inspecting the auto-emitter output without temperature-card noise.

```ts
const session = await ComparisonSession.create({ dtsPath: DTS, dllPath: DLL });
await session.runDcOp();

// Exact deck loaded into ngspice for this run:
const deck = session.getNgspiceDeck();
console.log(deck);

// Auto-generated emitter output before TEMP injection:
const rawDeck = session.getNgspiceDeck({ raw: true });
```

Use this when:
- Diagnosing why ngspice and digiTS disagree on a fixture you generated programmatically (read the deck, confirm the device cards, model cards, and node names are what you expect).
- Asserting in a test that the auto-generated netlist contains a specific element line / model card (golden-file style).
- Capturing the deck to a `.cir` file for standalone replay outside the harness (e.g. when handing off a parity bug to ngspice tooling).

### MCP tool surface

Registered in `scripts/mcp/harness-tools.ts:registerHarnessTools`, invoked once from `scripts/circuit-mcp-server.ts:53`. Each tool wraps a `ComparisonSession` method and serialises results via `formatComparedValue` / `formatNumber`.

Handle lifecycle: `harness_start` allocates handle (`h0`, `h1`, ...). State map capped at 10000. Tools other than `harness_start`/`harness_describe`/`harness_dispose` require a prior `harness_run`.

| Tool | MCP params | Returns |
|---|---|---|
| `harness_start` | `dtsPath` (required), `dllPath?`, `tolerance?` (`vAbsTol`, `iAbsTol`, `relTol`, `qAbsTol` — defaults 1e-6 / 1e-12 / 1e-3 / 1e-14), `maxOurSteps?` (default 5000) | `{handle, status, dtsPath, topology}`. |
| `harness_run` | `handle`, `stopTime?` (default 1e-5), `startTime?` (default 0), `maxStep?` (default `stopTime/100`) | `{handle, analysis: "tran", summary, errors}`. **MCP always invokes transient.** Headless `runDcOp()` is reachable only via the direct API. |
| `harness_describe` | `handle` | `{handle, matrixSize, nodeCount, branchCount, elementCount, components, nodes, nodeMapping}`. Components include `pins: [{label, nodeIndex}]` and `slots`. **Does NOT require `harness_run` first.** |
| `harness_dispose` | `handle` | `{handle, success}`. Throws on unknown handle. |
| `harness_session_map` | `handle` | `{handle, sessionMap}` (passthrough of `session.sessionMap()`). |
| `harness_get_step` | `handle`, `index?` OR `time?`, `side?` (`"ours"` default) | `{handle, step}` (formatted `StepDetail`). NaN normalised to `-1` for JSON type-stability. |
| `harness_get_attempt` | `handle`, `stepIndex`, `phase`, `phaseAttemptIndex`, `iterationRange?`, `offset?`, `limit?`, `nodes?`, `component?` | `{handle, attempt}` or `{handle, attempt, slice: {matrixIndices, labels, fullMatrixSize}}` when slice params given. With slice: matrix reduced to K×K row-major; `nodeLabels`/`nodeIndices` populated. |
| `harness_export` | `handle`, `includeAllSteps?` (default false), `onlyDivergences?`, `path?` | `{handle, exportedAt, dtsPath, analysis, summary, topology, steps, sizeBytes, writtenTo?}`. |

`phase` enum (`types.ts:285-295`):
`"dcopInitJct"`, `"dcopInitFix"`, `"dcopInitFloat"`, `"dcopDirect"`, `"dcopGminDynamic"`, `"dcopGminSpice3"`, `"dcopSrcSweep"`, `"tranInit"`, `"tranPredictor"`, `"tranNR"`.

`harness_get_attempt` errors:
- `"slice resolved to empty index set"` — no node/component matched.
- `"ambiguous node label '...' matches ..."` — multiple `/`-segment matches.
- `"unknown component '...'. Known: ..."`.

When both `nodes` and `component` are given, indices are unioned, deduplicated, sorted ascending.

---

## 6. Returned data shapes

### `IterationSnapshot` (`types.ts:158-242`)

Raw per-NR-iteration capture. Reachable via `session.ourSession!.steps[s].attempts[a].iterations[i]` and via `getAttempt` (transformed into `IterationSideData`).

| Field | Type | Meaning |
|---|---|---|
| `iteration` | `number` | 0-based NR iteration within attempt. |
| `matrixSize` | `number` | `CKTmaxEqNum + 1` (N+2 convention). |
| `rhsBufSize` | `number` | Allocation length of `rhs/rhsOld/preSolveRhs`. |
| `voltages` | `Float64Array` | POST-solve solution. |
| `prevVoltages` | `Float64Array` | PRE-solve input (initial guess for iter 0; previous iter's solution otherwise). |
| `preSolveRhs` | `Float64Array` | RHS `b` AFTER cktLoad, BEFORE `solver.factor()`. |
| `matrix` | `MatrixEntry[]` | Sparse `[{row, col, value}]` BEFORE LU. |
| `elementStates` | `ElementStateSnapshot[]` | `{elementIndex, label, slots, state1Slots, state2Slots}` per element. |
| `noncon` | `number` | Devices reporting non-converged. |
| `diagGmin` / `srcFact` | `number` | DCOP gmin-step / source-step parameters. 0 outside their phases. |
| `initMode` | `string` | `bitsToName(cktMode)` — e.g. `"MODEDCOP\|MODEINITJCT"`. |
| `order` / `delta` / `method` | Integration order, active CKTdelta this iter, `'trapezoidal' \| 'gear'`. |
| `ag` | `Float64Array(7)` | ag[0..MAXORDER]. Slots 2..6 zero on ngspice side. |
| `globalConverged` / `elemConverged` | `boolean` | Predicates. |
| `limitingEvents` | `LimitingEvent[]` | `{label, junction, vBefore, vAfter, wasLimited}`. |
| `convergenceFailedElements` | `string[]` | Labels failing `elemConverged`. |
| `lteDt?` | `number` | LTE-proposed next-dt. **Only on the FINAL accepted iter of a step.** |

### `IterationSideData` (`types.ts:849-974`)

Transformed per-iteration view returned by `getAttempt`. One side at a time. Fields beyond `IterationSnapshot`:

| Field | Type |
|---|---|
| `nodeVoltages` | `Record<label, number>` — POST-solve, keyed by topology label (`"R1:pos"`, `"Q1:B"`). |
| `nodeVoltagesBefore` | `Record<label, number>` — PRE-solve input. |
| `branchValues` | `Record<label, number>` — branch rows (matrix idx ≥ nodeCount). |
| `elementStates` / `elementStates1Slots` / `elementStates2Slots` | `Record<elLabel, Record<slotName, number>>`. |
| `rhs` / `residual` | `number[]` — pre-solve RHS / `A·v_input − b`. Sliced to K when MCP slice applied. |
| `residualInfinityNorm` | max-abs over `residual`. |
| `matrix` | `number[] \| null` — full N×N row-major (or K×K when sliced). |
| `nodeLabels?` / `nodeIndices?` | Sliced mode only. |

### `ComparedValue` (`types.ts:87-94`)

`{ours, ngspice, delta, absDelta, relDelta, withinTol}`. **`withinTol === (ours === ngspice)` (IEEE-754 identity, NOT numerical tolerance).**

### `NRAttempt` / `StepSnapshot` / `AttemptSummary` / `PairedAttempt` / `PairedIteration` / `StepDetail` / `AttemptDetail` / `SessionMap` / `StepShapeRow` / `AttemptShapeRow`

See `types.ts:316-345` and `types.ts:787-990`. Compact field meaning:

- `NRAttempt`: `{dt, iterations, converged, iterationCount, phase, outcome, phaseParameter?, role?}`. `outcome` ∈ `accepted | nrFailedRetry | lteRejectedRetry | dcopSubSolveConverged | dcopPhaseHandoff | tranPhaseHandoff | finalFailure`. `role` ∈ `coldStart | mainSolve | finalVerify | junctionPrime | predictorPass | tranSolve` (cross-phase pairing key).
- `StepSnapshot`: top-level `iterations` duplicates the accepted-attempt's iterations; canonical source is `attempts[acceptedAttemptIndex].iterations`.
- `AttemptSummary`: `endNodeNorm` is L2 over `[0, nodeCount)` of last iter's `voltages`; `endBranchNorm` is L2 over `[nodeCount, matrixSize)`. NaN when no branch rows.
- `PairedAttempt.divergenceNorm`: L2 of `(ours − ngspice)` over `[0, nodeCount)` from FINAL iter; NaN when one side is null.
- `PairedIteration.divergenceNorm`: same, per iteration.

### `StepEndReport` (`types.ts:434-447`)

`{stepIndex, ourStepIndex, ngspiceStepIndex, presence, stepStartTime/stepEndTime/dt (ComparedValue), converged (per-side bool pair), iterationCount (ComparedValue), nodes: Record<label, ComparedValue>, branches: Record<label, ComparedValue>, components: Record<label, {deviceType, slots: Record<slotName, ComparedValue>}>}`.

`timeAlign` defaults to `true` for transient (ngspice step picked by nearest `stepEndTime`), `false` for DCOP.

### `SessionSummary` (`types.ts:504-521`)

`{analysis, stepCount (ComparedValue), presenceCounts: {both, oursOnly, ngspiceOnly}, worstStepStartTimeDelta, convergence: {ours, ngspice}, firstDivergence: {stepIndex, iterationIndex, stepStartTime, worstLabel, absDelta} | null, totals: {compared, passed, failed}, perDeviceType, integrationMethod, stateHistoryIssues}`.

`firstDivergence.iterationIndex` is the absolute iteration index inside the accepted-attempt's iteration list.

### `TopologySnapshot` (`types.ts:138-151`)

`{matrixSize, nodeCount, elementCount, elements: Array<{index, label, type, pinNodeIds}>, nodeLabels: Map<number, string>, matrixRowLabels: Map<number, string>, matrixColLabels: Map<number, string>}`.

`nodeLabels` keyed by 1-based nodeId (0 = ground). Branch row labels: `"<elementLabel>:branch"` (V-sources, AC sources, inductors).

---

## 7. Observability ladder

What each tier sees, and what no tier sees. For the engine-internal "when does X exist" picture, see `engine-flow.md` §5–6.

| Observable | T1 (`buildFixture`) | T2 (`createSelfCompare`) | T3 (`ComparisonSession.create` / MCP) | No tier |
|---|---|---|---|---|
| Final node voltage at step boundary | ✓ `engine.getNodeVoltage` | ✓ `getStepEnd` / `ourSession.steps[].iterations` | ✓ `getStepEnd` (paired) | |
| Final branch / pin current at step boundary | ✓ `engine.getBranchCurrent` / `getElementCurrent` | ✓ | ✓ paired | |
| Element power | ✓ `engine.getElementPower` | ✓ | ✓ | |
| `pool.state0[base+slot]` at step boundary | ✓ direct | ✓ via `IterationSnapshot.elementStates` | ✓ paired via `getStepEnd.components` | |
| `pool.state1[base+slot]` at step boundary | ✓ direct | ✓ | ✓ | |
| `pool.state2..state7` at step boundary | ✓ direct (post-warm-start) | ✓ | ✓ | |
| Convergence-log per-step `attempts[]` | ✓ `getConvergenceLog()` | ✓ + per-iter detail | ✓ | |
| Limiting events (whole step) | ✓ `setLimitingCapture` / `getLimitingEvents` | ✓ per-iter | ✓ paired (`getLimitingComparison`) | |
| Runtime diagnostics | ✓ `getRuntimeDiagnostics` | ✓ | ✓ | |
| Matrix entries (post-load, pre-LU) at iter K | | ✓ digiTS-only | ✓ paired (`getMatrixLabeled`, `harness_get_attempt`) | |
| Pre-solve RHS at iter K | | ✓ | ✓ paired (`getRhsLabeled`) | |
| Residual `A·v_input − b` | | ✓ | ✓ paired | |
| `state0/1/2` slot snapshots PER iteration | | ✓ | ✓ paired (`getStateHistory`, `getAttempt`) | |
| Per-iter `ag[0..6]` integration coefficients | | ✓ | ✓ paired | |
| `noncon`, `globalConverged`, `elemConverged` per iter | | ✓ | ✓ paired (`getConvergenceDetail`) | |
| `convergenceFailedElements` per iter | | ✓ | ✓ paired | |
| Per-iter limiting events (`vBefore`/`vAfter`/`wasLimited`) | | ✓ | ✓ paired | |
| `cktMode` decoded (`initMode`) per iter | | ✓ | ✓ | |
| gmin / source-fact phase parameters | | ✓ | ✓ paired | |
| LTE-proposed next-dt (`lteDt`) | partial via `engine.getLteNextDt` (current only) | ✓ on final accepted iter | ✓ | |
| Bit-exact ngspice reference values | | | ✓ | |
| ngspice topology / node mapping | | | ✓ (`session.nodeMap`, `harness_describe`) | |
| Phase identity per attempt (`phase`, `role`, `outcome`) | | ✓ | ✓ | |
| LU factorisation contents | | | | ✗ (post-factor hook would need new wave-3 work) |
| Per-element companion-model intermediates (gd, gs before stamping) | | | | ✗ |
| SparseSolver pivot order | | | | ✗ |
| AC sweep parity | | | | ✗ (only DCOP + transient on T2/T3) |
| Per-device `cktTerr` LTE contributions | | | partial — final chosen `lteDt` only | ✗ individual contributions |
| Pin-level branch currents on devices without explicit branch rows | reconstructed from `nodeVoltages` + device params or `coordinator.readElementCurrent` | | | ✗ direct |

If your assertion needs a row marked ✗, escalate — that's wave-3 capture work, not a test design problem.

---

## 8. `.dts` authoring

A `.dts` file is the JSON serialisation of a `Circuit`. T3 reads it from disk to drive both digiTS and ngspice off the same source-of-truth.

**Format**: same shape as the `CircuitSpec` accepted by `facade.build({components, connections})`. JSON, ~30 lines for a single-component test circuit.

**Location**: `src/components/<area>/__tests__/fixtures/`.
**Naming**: `<component>-canon-<category>.dts` (e.g. `bjt-canon-stamp.dts`, `bjt-canon-transient.dts`). One `.dts` may serve multiple T3 categories if the same topology exercises both.

**Procedure**:

1. Find an existing `.dts` under `src/**/__tests__/fixtures/` as a structural template.
2. Adapt components and connections.
3. Pick parameter values that produce a deterministic operating point. Avoid edge-case parameters where ngspice and digiTS differ silently (start with textbook values).
4. Reference via `dtsPath: path.resolve("src/components/<area>/__tests__/fixtures/<name>.dts")`.

**Programmatic alternative for T2**: `createSelfCompare({ buildCircuit })` accepts a builder, no `.dts` needed. T2 is bit-exact within digiTS but DOES NOT pair against ngspice — only sufficient for T2 categories.

**If `.dts` authoring is genuinely blocking** (multi-stage topology requiring specialist knowledge, or unknown canonical parameters), surface as an escalation rather than guessing values.

---

## 9. Banned patterns

Run a literal text scan of any modified test file before reporting completion. Each pattern below is a hard fail.

### B-1. Engine-impersonator constructions (inline OR imported)

- `new LoadContext(...)`, `new SetupContext(...)`, `new CKTCircuitContext(...)`.
- Object literals shaped like `{matrix, rhs, ckt, simTime, ...}` passed to `element.load()` / `element.setup()`.
- `new StatePool(...)` outside `buildFixture` or `ComparisonSession`.
- A test-local class named `MockSolver`, `FakeSolver`, `TestSolver`, `MockCoordinator`, `FakeEngine`, `TestEngine`, `MockMatrix`, etc.
- A function (any name) whose body assembles a `LoadContext`-shaped object: `makeCtx`, `loadCtxFromFields`, `buildLoadCtx`, `makeLoadContext`, `buildTestCtx`, `buildHarnessCtx`, `makeMnaCtx`. **Banned by shape, not name.**
- Direct calls `element.setup(...)`, `element.load(...)`, `element.acceptStep(...)`, `element.initState(...)`, `element.applyInitialValues(...)`.
- `compileUnified(...)` called directly from a test.
- `mnaEngine._setup(...)`, `mnaEngine._load(...)`, `mnaEngine._walkSubElements(...)`.

### B-2. Private-field tunnelling

- `(x as any)._priv`, `(x as unknown as { _foo })._priv`.
- `as MNAEngine`, `as DefaultSimulationCoordinator`, `as ConcreteCompiledAnalogCircuit` to reach a non-interface field at any boundary other than the fixture itself.
- A subclass `class TestX extends X { get _privateField() { return this._priv; } }`.
- Writes to `(x as any)._stateBase = N`.

### B-3. Slot-index access bypassing the schema

- `import { SLOT_X } from "../foo.js"` — slot indices come from `<SCHEMA>.indexOf.get("X")!`.
- Hard-coded numeric slot indices (`pool.state0[base + 3]` with `3` literal).

### B-4. Coverage erosion

- `console.log` / `console.error` / `console.warn` / `console.debug` left in the file.
- New `it.skip(...)`, `it.todo(...)`, `describe.skip(...)` introduced to make CI green. Pre-existing skips you have not touched are fine.
- `expect(...)` calls with no actual matcher.
- File-header migration-history docstrings; `// originally tested X, now Y` tombstones; `// see commit ABC` inline comments. (See `feedback_no_migration_history_in_test_files`.)

### B-5. Forbidden ngspice-parity verdicts (in code, comments, OR test names)

`tolerance`, `mapping`, `mapping table`, `equivalent under`, `pre-existing`, `intentional divergence`, `partial`, `citation divergence`, `documentation hygiene`. Reaching for any of these to close a numerical gap is the signal you're papering over a real divergence — see `CLAUDE.md` "ngspice Parity Vocabulary" rule.

### B-6. Phantom ngspice citations

Do not cite an ngspice file or function unless you have **opened it** at `ref/ngspice/...` and confirmed the symbol exists. (See `feedback_no_phantom_ngspice_citations`.)

### B-7. Out-of-canon tests passed off as in-canon

If an existing test's assertion does not match any of the 9 categories in §1, the action is `DELETE-AND-RECORD` — not `KEEP` or `REWRITE`. Forcing a misfit into a category to avoid the deletion record is the same anti-pattern as inline-resurrecting a banned helper.
