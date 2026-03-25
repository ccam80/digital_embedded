# Unified Component Architecture

## Prerequisite: Node Identity Completion

The pin-unification work (spec/pin-unification-plan.md) established that **pin
identity is the label** and the compiler is the sole authority on pin→node
mapping. This section audits the current state of node identity and current
readout, identifies what remains incomplete, and defines the delta work needed
before the unified compilation pipeline (Section 4) can proceed.

### Current state of `AnalogElement.nodeIndices`

The compiler sets (compiler.ts lines 890–895):

```typescript
// compiler.ts lines 890-895
// Call the analog factory — returns AnalogElementCore (no nodeIndices).
// Compiler is the SOLE place nodeIndices is constructed — always pinLayout order.
const core = def.analogFactory!(pinNodes, internalNodeIds, absoluteBranchIdx, props, getTime);
const element: AnalogElement = Object.assign(core, {
  nodeIndices: pinNodeIds,   // ← pin nodes ONLY, in pinLayout order
});
```

Internal nodes (allocated via `getInternalNodeCount`, passed to factories as
`internalNodeIds`) are captured in factory closure variables and **never stored
on the element**. After construction they are invisible to all engine-level
consumers.

The `AnalogElement` interface (element.ts) still carries a single `nodeIndices`
field. The `pinNodeIds`/`allNodeIds` split described below does **not yet
exist**.

### Three consumers, three different needs, one field

| Consumer | What it needs | What `nodeIndices` contains | Correct? |
|----------|--------------|---------------------------|----------|
| **Stamp methods** | Named node IDs | N/A — reads closure variables, not `nodeIndices` | Yes |
| **Physics readout** (`getElementPower`, `getElementPinCurrents`, BDF-2 history) | Pin node IDs in pinLayout order | Pin node IDs in pinLayout order | Yes (by design after pin unification) |
| **Topology validation** (`detectWeakNodes`, `detectVoltageSourceLoops`, `_inferNodeCount`) | ALL node IDs: pins + internals | Pin node IDs only (compiler.ts line 924: `nodeIds: pinNodeIds`) | **No — internals are missing** |

### Concrete bugs / fragilities

The following bugs exist in the current code.

1. **`detectWeakNodes` is blind to internal nodes.** If a factory allocates an
   internal node but connects it to only one terminal (factory bug), the
   topology validator won't detect the floating node. The matrix goes singular
   at runtime with no diagnostic pointing to the root cause. Masked today
   because all existing factories happen to wire correctly.

2. **`_inferNodeCount` undercounts.** `dc-operating-point.ts` line 333 iterates
   `el.nodeIndices` to find the maximum node ID. If an internal node ID exceeds
   all pin node IDs, the inferred node count is wrong. Mitigated by the
   `matrixSize` fallback at line 339, but latent.

3. **`topologyInfo` in the compiler feeds only `pinNodeIds` to validators**
   (compiler.ts line 924: `nodeIds: pinNodeIds`). Internal nodes are excluded
   from all topology checks.

4. **`getElementPower()` is fragile with respect to future renames.**
   analog-engine.ts lines 617–618 iterate `i < pinCurrents.length && i < el.nodeIndices.length`,
   pairing `nodeIndices[i]` with `pinCurrents[i]`. This works correctly now
   because `nodeIndices` contains only pin nodes. If internal nodes were ever
   re-added to `nodeIndices`, power calculation would silently pair wrong nodes
   with wrong currents.

### The 2-terminal current convention

The engine's current readout has three paths (analog-engine.ts lines 550–628):

| Path | When used | Source |
|------|-----------|--------|
| `voltages[el.branchIndex]` | `branchIndex >= 0` (voltage sources, inductors) | MNA solver computed it directly. Clean. |
| `el.getCurrent(voltages)` | 2-terminal elements that implement `getCurrent` | Element computes `I = G × (V_A - V_B)` etc. |
| `el.getPinCurrents(voltages)` | Elements that implement `getPinCurrents` — takes priority | Element returns per-pin currents in pinLayout order. |

`getElementPinCurrents` (analog-engine.ts lines 579–599) checks
`getPinCurrents` first; if absent, falls back to manufacturing `[+I, -I]` from
`getElementCurrent` for 2-terminal elements:

```typescript
// analog-engine.ts lines 589-595
// For 2-terminal elements, derive from scalar getCurrent
if (el.nodeIndices.length === 2) {
  const I = this.getElementCurrent(elementId);
  // Convention: positive I flows node[0] → node[1]
  return [I, -I];
}
```

The power fallback at analog-engine.ts lines 624–627 still exists:

```typescript
// analog-engine.ts lines 624-627 — reached only if getPinCurrents returns null
const vA = this.getNodeVoltage(el.nodeIndices[0] ?? 0);
const vB = this.getNodeVoltage(el.nodeIndices[1] ?? 0);
return (vA - vB) * this.getElementCurrent(elementId);
```

`branchIndex` is standard MNA formalism — the index into the solution vector
where the solver places the branch current for voltage sources and inductors.
Assigned by the compiler, read by the engine. Not a kludge.

#### Which elements still use the `getCurrent` path

Of all production component implementations, **two** retain `getCurrent`:

- `src/components/passives/resistor.ts` (line 184) — also has `getPinCurrents` (line 190)
- `src/components/passives/capacitor.ts` (line 174) — also has `getPinCurrents` (line 182)

Both also implement `getPinCurrents`, so `getElementPinCurrents` takes the
`getPinCurrents` path, not the `[+I, -I]` fallback. The `getCurrent`
implementations are dead code with respect to the engine's pin-current path;
they are still reached only via `getElementCurrent` directly (e.g. the power
fallback branch).

All other production components — 45+ files across
`src/components/semiconductors/`, `src/components/active/`,
`src/components/passives/` (excluding resistor/capacitor), `src/components/io/`,
`src/components/sources/`, `src/components/switching/`, `src/components/sensors/`,
`src/analog/behavioral-*.ts`, `src/analog/fet-base.ts`, and
`src/analog/bridge-adapter.ts` — implement `getPinCurrents` only.

`src/analog/test-elements.ts` has `getCurrent` implementations for internal
test scaffolding; these are not part of the production element set.

### Remaining work: explicit node identity on AnalogElement

The `nodeIndices` field should be split into two purpose-specific fields to
make the existing accidental correctness explicit and fix the topology
validation gap:

```typescript
interface AnalogElement {
  /** Pin node IDs in pinLayout order. Used by physics readout
   *  (power, per-pin currents, BDF-2 heuristic). */
  readonly pinNodeIds: readonly number[];

  /** ALL MNA node IDs this element touches: pins + internals.
   *  Used by topology validation and node count inference.
   *  Always: allNodeIds = [...pinNodeIds, ...internalNodeIds]. */
  readonly allNodeIds: readonly number[];

  /** Branch-current row index in MNA solution vector.
   *  >= 0 for voltage sources and inductors; -1 for all others.
   *  Assigned by compiler, read by engine. Standard MNA. */
  readonly branchIndex: number;

  // stamp methods, getCurrent, getPinCurrents — see below
}
```

The compiler constructs both (replacing the current line 894 assignment):

```typescript
const element: AnalogElement = Object.assign(core, {
  pinNodeIds: pinNodeIds,
  allNodeIds: [...pinNodeIds, ...internalNodeIds],
});
```

Consumer migration:

| Consumer | Current (uses `nodeIndices`) | After rename |
|----------|------------------------------|-------------|
| `getElementPower()` analog-engine.ts:617–618 | `el.nodeIndices[i]` | `el.pinNodeIds[i]` |
| `getElementPinCurrents()` 2-terminal check analog-engine.ts:590 | `el.nodeIndices.length === 2` | `el.pinNodeIds.length === 2` |
| BDF-2 history analog-engine.ts:347–349 | `el.nodeIndices[0]`, `el.nodeIndices[1]` | `el.pinNodeIds[0]`, `el.pinNodeIds[1]` |
| Power fallback analog-engine.ts:625–626 | `el.nodeIndices[0]`, `el.nodeIndices[1]` | `el.pinNodeIds[0]`, `el.pinNodeIds[1]` |
| `detectWeakNodes` compiler.ts:924 | `topologyInfo.nodeIds` (pin only) | `el.allNodeIds` (pins + internals) |
| `_inferNodeCount` dc-operating-point.ts:333 | `el.nodeIndices` (pin only) | `el.allNodeIds` (pins + internals) |
| `detectVoltageSourceLoops` compiler.ts:628 | `topologyInfo.nodeIds` | `el.allNodeIds` |
| WireCurrentResolver | already migrated to `elementResolvedPins` | No change |

### Remaining work: eliminating `getCurrent` and the engine fallback

The `getPinCurrents` migration is **nearly complete**. Current status:

- **45+ production components already implement `getPinCurrents` only.**
  All behavioral models (`behavioral-gate.ts`, `behavioral-flipflop.ts`,
  `behavioral-combinational.ts`, `behavioral-sequential.ts`,
  `behavioral-flipflop-variants.ts`, `behavioral-remaining.ts`),
  all semiconductors, all active components, all controlled sources,
  bridge adapters, and FET base are done.

- **2 production components have both `getCurrent` and `getPinCurrents`:**
  `resistor.ts` and `capacitor.ts`. Their `getCurrent` implementations are
  superseded by `getPinCurrents` for the pin-current path. The remaining
  step is to delete the `getCurrent` method from each.

- **`getCurrent?` is still optional on the interface** (element.ts line 226).
  After the two removals above, it can be deleted from the interface entirely.

- **The engine fallback** (`[+I, -I]` manufacturing at analog-engine.ts:589–595,
  power fallback at lines 624–627) can be removed once `getCurrent` is gone
  from the interface. At that point `getElementPinCurrents` simplifies to a
  direct `el.getPinCurrents(this._voltages)` call, and `getElementPower` no
  longer needs a fallback path.

The `getCurrent` contract (positive = conventional flow from node[0] to
node[1], `pinLayout[0]` is the positive terminal) is an **undocumented
assumption** between the two remaining implementations and the engine fallback.
Deleting both removes the assumption entirely.

#### KCL convention

**Passive elements and active elements with explicit supply pins**: the sum of
all `getPinCurrents` entries MUST be zero. KCL is enforced.

**Behavioral models with implicit supply** (gates, flipflops, mux, demux,
counters, registers, drivers): the sum of `getPinCurrents` entries equals the
implicit supply current flowing to/from MNA ground (node 0). This is
**expected and correct** — the behavioral model deliberately hides the power
supply. The residual IS the supply current.

Concretely, a behavioral AND gate stamps:
- Input pins: conductance `1/rIn` from pin node to ground → `I_in = V_pin / rIn`
- Output pin: Norton equivalent `1/rOut` from pin node to ground + current
  source `V_target/rOut` → `I_out = (V_pin - V_target) / rOut`

The ground path is the implicit Vcc/GND. `getPinCurrents` returns current at
each visible pin. The sum is nonzero — that difference is the supply current
the model draws from ground. This is physically honest: the model approximates
the supply, and the approximation is visible in the current balance.

#### Behavioral model implementation pattern

All behavioral models use `DigitalInputPinModel` and `DigitalOutputPinModel`.
These already know their node IDs and stamp conductances. The `getPinCurrents`
implementation reads the solved voltage and computes current from the same
constitutive equation that was stamped:

```typescript
// Inside a behavioral gate factory:
getPinCurrents(voltages: Float64Array): number[] {
  const currents: number[] = [];

  // Input pins: I = V_node × G_in (loading to ground)
  for (const inp of inputs) {
    const v = readMnaVoltage(inp.nodeId, voltages);
    currents.push(v / inp.spec.rIn);  // positive = into element
  }

  // Output pin: I = (V_node - V_target) × G_out
  const vOut = readMnaVoltage(output.nodeId, voltages);
  const gOut = 1 / output.spec.rOut;
  currents.push((vOut - output.targetVoltage) * gOut);  // negative when sourcing

  return currents;
}
```

For reactive behavioral pins (with `cIn`/`cOut`), the companion model current
is added to the DC current. The companion state is already maintained by
`stampCompanion` — the `getPinCurrents` implementation reads the same `geq`/
`ieq` coefficients. This pattern is already implemented in all behavioral files.

#### Engine simplification

With `getPinCurrents` mandatory and `getCurrent` removed, the engine cascade
collapses to:

```typescript
getElementPinCurrents(elementId: number): number[] {
  const el = this._compiled.elements[elementId];
  return el.getPinCurrents(this._voltages);
}

getElementCurrent(elementId: number): number {
  // Convenience for 2-terminal: return current at pin 0
  const el = this._compiled.elements[elementId];
  return el.getPinCurrents(this._voltages)[0];
}

getElementPower(elementId: number): number {
  const el = this._compiled.elements[elementId];
  const currents = el.getPinCurrents(this._voltages);
  let power = 0;
  for (let i = 0; i < currents.length; i++) {
    power += this.getNodeVoltage(el.pinNodeIds[i]) * currents[i];
  }
  return power;
}
```

No fallbacks, no implicit conventions, no branching on terminal count.

### Relationship to unified architecture

This is a prerequisite for the unified compilation pipeline (Section 4). The
unified netlist extraction needs to partition nodes into solver domains. If
internal nodes are invisible, the partitioner can't validate domain boundaries
correctly. Complete this before Phase 3 (unified netlist extraction) of the
main migration.

---

## Problem

The codebase treats analog and digital as two separate systems that happen to
share a component registry. The split is structural — in directory layout, type
definitions, compilation pipelines, engine interfaces, editor palette filtering,
app-init branching, and the mental model imposed on users and developers.

In practice the two are tightly coupled. A single AND gate already carries both
a digital `executeFn` and an `analogFactory`. A mixed circuit already gets
partitioned and bridged. But every layer reinvents the analog-vs-digital
decision: the circuit declares `metadata.engineType`, the registry declares
`def.engineType`, the palette filters by engine type, `app-init` branches on
engine type in 15+ places, the runner tracks `engineType` per compiled record,
the facade holds separate `_compiled` and `_compiledAnalog` slots.

The result: adding one component that spans both domains (the recent pin-
unification work) requires touching every layer. The system fights you because
it was designed around a binary choice that doesn't reflect reality.

## Design Principle

**There is one kind of thing: a component.** A component has pins, properties,
a visual representation, and one or more **calculation methods** (models). A
resistor has one model (MNA analog). An AND gate has two (event-driven digital
and behavioral analog). A D flip-flop has two. A BJT has one (SPICE analog).
The system doesn't care — it sees components with models.

**Every component on the schematic simulates, always, in whatever model it is
set to.** There is no simulator "mode". There is no "current context" that
makes components ineligible. The compiler reads the schematic, examines each
component's active model, partitions into solver domains, inserts bridges at
domain boundaries, and runs all solvers simultaneously.

A circuit with only resistors produces only an MNA solve. A circuit with only
AND gates produces only a digital solve. A circuit with both produces both
solvers with bridges. The user never chooses. The system derives.

**The end state:** a unified component system that just happens to have multiple
calculation methods per component. The registry, palette, editor, facade,
coordinator, and all consumers see one interface. The existence of different
solver backends is an implementation detail hidden behind the compilation
pipeline — not a top-level architectural split that every layer must be aware of.

## Terminology

| Term | Meaning |
|------|---------|
| **Component** | A single entity on the schematic. Has visual representation, properties, pin declarations, and one or more **models**. |
| **Model** | A simulation behaviour attached to a component. A model targets exactly one **solver backend**. |
| **Solver backend** | A simulation engine that processes one class of physics: event-driven digital logic, MNA analog, or future backends (Verilog-A, VHDL behavioral, etc.). |
| **Active model** | The model currently selected for a component instance. For components with one model, it's always active. For components with multiple models, the user (or a default) selects one. |
| **Solver domain** | The set of component instances in a circuit whose active models target the same solver backend. |
| **Domain boundary** | A net where pins from two different solver domains meet. The compiler inserts bridge adapters here. |
| **Coordinator** | The runtime object that owns all solver backend instances, synchronizes their stepping, and manages bridge adapters at domain boundaries. |

---

## 1. Component Definition

### Current

```typescript
interface ComponentDefinition {
  name: string;
  engineType?: "digital" | "analog" | "both";
  typeId: number;
  factory: (props: PropertyBag) => CircuitElement;
  executeFn: ExecuteFunction;
  sampleFn?: ExecuteFunction;
  pinLayout: PinDeclaration[];
  propertyDefs: PropertyDefinition[];
  attributeMap: AttributeMapping[];
  category: ComponentCategory;
  helpText: string;
  stateSlotCount?: number | ((props: PropertyBag) => number);
  defaultDelay?: number;
  switchPins?: [number, number];
  analogFactory?: (...) => AnalogElement;
  requiresBranchRow?: boolean;
  getInternalNodeCount?: (props: PropertyBag) => number;
  analogDeviceType?: DeviceType;
  pinElectrical?: PinElectricalSpec;
  pinElectricalOverrides?: Record<string, PinElectricalSpec>;
  simulationModes?: ('logical' | 'analog-pins' | 'analog-internals')[];
  transistorModel?: string;
}
```

Problems:
- `engineType` is a declared tag that duplicates what the presence of
  `executeFn` / `analogFactory` already tells you.
- Digital-specific fields (`executeFn`, `sampleFn`, `stateSlotCount`,
  `defaultDelay`, `switchPins`) and analog-specific fields (`analogFactory`,
  `requiresBranchRow`, `getInternalNodeCount`, `analogDeviceType`) are
  interleaved at the top level with no grouping.
- `noOpAnalogExecuteFn` exists solely to satisfy the `executeFn` requirement on
  components that have no digital behaviour.
- `simulationModes` is a stringly-typed list whose entries partially overlap
  with the model concept.

### Proposed

```typescript
interface ComponentDefinition {
  // --- Identity ---
  name: string;
  typeId: number;                         // auto-assigned by registry

  // --- Visual / schematic ---
  factory: (props: PropertyBag) => CircuitElement;
  pinLayout: PinDeclaration[];
  propertyDefs: PropertyDefinition[];
  attributeMap: AttributeMapping[];
  category: ComponentCategory;
  helpText: string;

  // --- Simulation models ---
  models: ComponentModels;
  defaultModel?: string;                  // key into models; first available if omitted
}

interface ComponentModels {
  /** Event-driven digital: reads/writes bit vectors on discrete nets. */
  digital?: DigitalModel;
  /** MNA analog: stamps conductance/current into sparse matrix. */
  analog?: AnalogModel;
  // Future: verilogA?: VerilogAModel; vhdl?: VhdlModel; etc.
}

interface DigitalModel {
  executeFn: ExecuteFunction;
  sampleFn?: ExecuteFunction;
  stateSlotCount?: number | ((props: PropertyBag) => number);
  defaultDelay?: number;
  switchPins?: [number, number];
  inputSchema?: string[];
  outputSchema?: string[];
}

interface AnalogModel {
  factory: AnalogElementFactory;
  requiresBranchRow?: boolean;
  getInternalNodeCount?: (props: PropertyBag) => number;
  deviceType?: DeviceType;
  transistorModel?: string;
  pinElectrical?: PinElectricalSpec;
  pinElectricalOverrides?: Record<string, PinElectricalSpec>;
}
```

Derived capabilities replace declared tags:

```typescript
// These are utility functions, not stored fields.
function hasDigitalModel(def: ComponentDefinition): boolean {
  return def.models.digital !== undefined;
}
function hasAnalogModel(def: ComponentDefinition): boolean {
  return def.models.analog !== undefined;
}
function availableModels(def: ComponentDefinition): string[] {
  return Object.keys(def.models);
}
```

### Active Model Selection

Each component instance carries an `activeModel` property (stored in its
`PropertyBag`, key: `"simulationModel"`). The value is a key into
`def.models` — e.g. `"digital"`, `"analog"`.

Rules:
- If the component has exactly one model, that model is always active.
  The property is hidden from the property panel.
- If the component has multiple models, the property panel shows a dropdown.
  The default is `def.defaultModel` (or the first key in `models`).
- The compiler reads `activeModel` per instance, not per type. Two AND gates
  on the same schematic can have different active models.

The current `simulationModes` array (`['logical', 'analog-pins',
'analog-internals']`) maps onto this as follows:

| Old mode | New model key | Meaning |
|----------|---------------|---------|
| `logical` | `digital` | Use digital `executeFn` |
| `analog-pins` | `analog` | Use `analogFactory` with pin-level behavioral model |
| `analog-internals` | `analog` + prop `analogDetail: "transistor"` | Use `analogFactory` with transistor-level expansion |

The `analog-pins` vs `analog-internals` distinction is a property of the
analog model, not a separate model type. A component's `AnalogModel.factory`
reads the `analogDetail` property to decide whether to stamp a behavioral
model or expand to transistors.

### Example Definitions

**AND gate** (two models):

```typescript
export const AndDefinition: ComponentDefinition = {
  name: "And",
  typeId: -1,
  factory: andFactory,
  pinLayout: buildPinDeclarations(2, 1, false),
  propertyDefs: AND_PROPERTY_DEFS,
  attributeMap: AND_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText: "...",
  models: {
    digital: {
      executeFn: executeAnd,
    },
    analog: {
      factory: makeAndAnalogFactory(0),
      transistorModel: "CmosAnd2",
      pinElectrical: DEFAULT_CMOS_SPEC,
    },
  },
  defaultModel: "digital",
};
```

**Resistor** (one model):

```typescript
export const ResistorDefinition: ComponentDefinition = {
  name: "Resistor",
  typeId: -1,
  factory: resistorFactory,
  pinLayout: RESISTOR_PINS,
  propertyDefs: RESISTOR_PROPERTY_DEFS,
  attributeMap: RESISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText: "...",
  models: {
    analog: {
      factory: createResistorElement,
    },
  },
};
```

**D Flip-Flop** (two models):

```typescript
export const FlipflopDDefinition: ComponentDefinition = {
  name: "FlipflopD",
  typeId: -1,
  factory: dffFactory,
  pinLayout: DFF_PINS,
  propertyDefs: DFF_PROPERTY_DEFS,
  attributeMap: DFF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText: "...",
  models: {
    digital: {
      executeFn: executeDFlipflop,
      sampleFn: sampleDFlipflop,
      stateSlotCount: 2,
    },
    analog: {
      factory: makeDFlipflopAnalogFactory(),
      transistorModel: "CmosDFlipflop",
      pinElectrical: DEFAULT_CMOS_SPEC,
    },
  },
  defaultModel: "digital",
};
```

---

## 2. Circuit Model

### Current

```typescript
interface CircuitMetadata {
  name: string;
  engineType: "digital" | "analog" | "auto";
  logicFamily?: LogicFamily;
  // ...
}
```

The `engineType` field forces a global choice before compilation. The "auto"
value triggers `detectEngineMode()` which scans components and classifies the
circuit as a whole. This is the wrong abstraction — a circuit doesn't have an
engine type. Components have models.

### Proposed

```typescript
interface CircuitMetadata {
  name: string;
  logicFamily?: LogicFamily;
  // engineType: REMOVED
}
```

No engine type on the circuit. The compiler derives solver domains from
component instance active models.

### Migration

During migration, `engineType` values in existing `.dig` files and JSON
circuits are handled as follows:

- `"digital"` → ignored (compiler derives from models; all existing digital
  components have `defaultModel: "digital"`)
- `"analog"` → on load, set `activeModel: "analog"` on every component that
  has an analog model and whose `activeModel` is not already set
- `"auto"` → ignored (this is now the only behaviour)

After migration, the field is no longer written on save. The loader accepts
it for backwards compatibility but does not propagate it.

**Backward compatibility guarantee for `.dig` files and JSON circuits:**
When loading an existing file where component instances have no
`simulationModel` property in their `PropertyBag`, the system falls through
to `def.defaultModel` (set per component type). For all dual-model
components (gates, flip-flops, mux, etc.), `defaultModel` is `"digital"`.
This means all existing circuits behave identically after the migration —
no per-instance property is needed in old files. Only circuits where the
user has explicitly changed a component to analog mode will have
`simulationModel` in the saved data.

---

## 3. Registry

### Current

```typescript
getByEngineType(engineType: "digital" | "analog"): ComponentDefinition[]
```

Filters by the declared `engineType` tag.

### Proposed

```typescript
getWithModel(modelKey: string): ComponentDefinition[]
// Returns all definitions that have models[modelKey] defined.

getAll(): ComponentDefinition[]
// Unchanged. Returns everything.
```

`getByEngineType` is removed. The palette calls `getAll()` and shows
everything. The property panel shows the model selector dropdown for
multi-model components.

---

## 4. Compilation Pipeline

### Current

Two independent top-level compilers:
- `compileCircuit(circuit, registry)` → `ConcreteCompiledCircuit` (digital)
- `compileAnalogCircuit(circuit, registry, ...)` → `ConcreteCompiledAnalogCircuit`

The facade (`DefaultSimulatorFacade`) and `app-init` choose which one to call
based on `circuit.metadata.engineType` and `detectEngineMode()`.

For mixed circuits, `partitionMixedCircuit()` splits the circuit into an outer
analog circuit and an inner digital circuit before handing them to the two
compilers. The analog compiler receives the digital partition as a side input
and creates `BridgeInstance` objects. `MixedSignalCoordinator` synchronizes
the two engines at runtime.

### Proposed

One entry point. The mixed-signal path becomes the only path.

```
compile(circuit, registry)
       │
       ▼
┌────────────────────────┐
│   1. Resolve Models    │  For each component instance, look up its
│                        │  activeModel → determine which solver backend
│                        │  owns it.
└────────────────────────┘
       │
       ▼
┌────────────────────────┐
│   2. Extract Netlist   │  Read schematic once: enumerate components,
│                        │  trace wire connectivity, resolve pins by label
│                        │  (pin-unification). Produces a unified Netlist
│                        │  with domain tags on each component.
└────────────────────────┘
       │
       ▼
┌────────────────────────┐
│   3. Partition          │  Group components by solver domain.
│                        │  Identify domain-boundary nets.
│                        │  Create bridge descriptors at boundaries.
└────────────────────────┘
       │
       ├──── digital partition ────▶ Digital Compiler ──▶ CompiledDigitalDomain
       │
       ├──── analog partition  ────▶ Analog Compiler  ──▶ CompiledAnalogDomain
       │
       ├──── bridge descriptors ──▶ Bridge Builder    ──▶ BridgeAdapter[]
       │
       ▼
┌────────────────────────┐
│   4. Assemble           │  Combine compiled domains + bridges into a
│      CompiledCircuit    │  single CompiledCircuit that the Coordinator
│                        │  can execute.
└────────────────────────┘
```

#### 4.1 Resolve Models

For each component instance `el` in the circuit:

```
def = registry.get(el.typeId)
modelKey = el.props.get("simulationModel") ?? def.defaultModel ?? firstKey(def.models)
model = def.models[modelKey]
```

This assigns every instance to exactly one solver domain.

#### 4.2 Flatten (prerequisite)

Before netlist extraction, subcircuits are resolved:

- **Same-domain subcircuits** are inlined (flattened). Their internal
  components become leaf elements in the parent circuit. This is physically
  lossless — for MNA, the matrix is identical whether components are in a
  subcircuit or at the top level. For digital, the wiring table is identical.
- **Cross-domain subcircuits** are preserved as opaque placeholders. The
  unified front-end records them as `CrossEngineBoundary` entries for bridge
  compilation later.

Domain classification uses `activeModel` per instance (from step 4.1), not
the old `engineType` tag. A subcircuit whose internal components all resolve
to the same domain as the parent is same-domain; otherwise cross-domain.

This is the existing `flattenCircuit()` algorithm with `engineType` checks
replaced by `activeModel` checks.

#### 4.3 Extract Netlist (unified)

**This step replaces three existing algorithms:**
- `traceNets()` in `src/engine/net-trace.ts` (digital)
- `buildNodeMap()` in `src/analog/node-map.ts` (analog)
- The union-find in `partitionMixedCircuit()` in `src/engine/mixed-partition.ts`

All three use the same core algorithm — union-find on pin world positions +
wire endpoints — but diverge in details. The unified version runs once and
produces everything all three currently produce.

##### Algorithm

```
Input:  flat circuit (leaf elements + cross-domain placeholders),
        registry, model assignments from step 4.1

Output: ConnectivityGroup[], component domain tags, boundary group set
```

1. **Collect slots.** For each element, compute `pinWorldPosition(el, pin)`
   for every pin. Assign each pin a numeric slot ID (element index × max
   pins + pin index). For each wire, assign two virtual slot IDs (start,
   end) and union them.

2. **Position-merge.** Build a `Map<string, number[]>` from position key
   `"${x},${y}"` → slot IDs at that position. Union all slots at each
   position.

3. **Tunnel-merge.** For each Tunnel element, collect its pin slot by label.
   Union all slots that share a Tunnel label.

4. **Extract groups.** Walk the union-find to produce `ConnectivityGroup[]`:

```typescript
interface ConnectivityGroup {
  /** Unique group ID (arbitrary, assigned by extraction). */
  groupId: number;
  /** All pin slots in this group, with their element + pin metadata. */
  pins: ResolvedGroupPin[];
  /** Wire objects touching this group (for wireSignalMap). */
  wires: Wire[];
  /** Which solver domains have pins on this group. */
  domains: Set<string>;  // e.g. {"digital"}, {"analog"}, {"digital","analog"}
  /** Bit width (from digital pins; undefined for pure-analog groups). */
  bitWidth?: number;
}

interface ResolvedGroupPin {
  elementIndex: number;
  pinIndex: number;
  pinLabel: string;
  direction: PinDirection;
  bitWidth: number;
  worldPosition: Point;
  wireVertex: Point | null;  // matched wire endpoint for current display
  domain: string;            // from element's activeModel
}
```

5. **Tag domains.** For each group, `domains` is the union of the `domain`
   values of all pins in the group. A group is a **boundary group** if
   `domains.size > 1`.

6. **Validate widths.** For groups with digital pins, enforce that all pins
   agree on bit width (same check as the current digital compiler's
   `BitsException`). Analog-only groups have no width concept.

##### What each existing algorithm contributed

| Concern | Currently handled by | In unified extraction |
|---------|---------------------|----------------------|
| Union-find on positions | All three | Single pass (step 1–2) |
| Tunnel merging | `net-trace.ts` + `node-map.ts` | Step 3 |
| Domain classification | `partitionMixedCircuit()` | Step 5 (from model assignments) |
| Boundary net detection | `partitionMixedCircuit()` | Step 5 (`domains.size > 1`) |
| Width validation | `net-trace.ts` (digital compiler) | Step 6 |
| Ground identification | `node-map.ts` (analog) | **Not here** — stays in analog backend |
| Multi-driver detection | Digital compiler | **Not here** — stays in digital backend |
| Splitter handling | Digital compiler (leaf executeFn) | **Not here** — splitters are digital components |

Ground identification, multi-driver shadow nets, and splitter bit
manipulation are domain-specific concerns that stay in their respective
backend compilers. The unified front-end produces connectivity groups;
backends interpret them.

#### 4.4 Partition

From the connectivity groups, produce two `SolverPartition` objects:

```typescript
interface SolverPartition {
  /** Components assigned to this solver. */
  components: PartitionedComponent[];
  /** Connectivity groups relevant to this domain (internal + boundary). */
  groups: ConnectivityGroup[];
  /** Bridge stubs at boundary groups. */
  bridgeStubs: BridgeStub[];
  /** Cross-domain subcircuit boundaries (for bridge compilation). */
  crossEngineBoundaries: CrossEngineBoundary[];
}

interface PartitionedComponent {
  /** Original circuit element (position, rotation, mirror, typeId, props). */
  element: CircuitElement;
  /** Registry definition. */
  definition: ComponentDefinition;
  /** The active model for this instance. */
  model: DigitalModel | AnalogModel;
  /** Resolved pins with world positions and group membership. */
  resolvedPins: ResolvedGroupPin[];
}
```

**Digital partition** receives:
- All components with `modelKey === "digital"`
- All groups that have at least one digital pin
- Bridge In/Out stub components at boundary groups (virtual `In` for signals
  entering from analog, virtual `Out` for signals leaving to analog)

**Analog partition** receives:
- All components with `modelKey === "analog"`
- All groups that have at least one analog pin
- Bridge adapter stubs at boundary groups (Norton equivalent adapters)
- Cross-engine boundary records (for subcircuit bridge compilation)

**Bridge descriptors** (one per boundary group):

```typescript
interface BridgeDescriptor {
  /** The connectivity group at the domain boundary. */
  boundaryGroup: ConnectivityGroup;
  /** Signal direction: which domain drives, which receives. */
  direction: "digital-to-analog" | "analog-to-digital";
  /** Bit width (from digital side). */
  bitWidth: number;
  /** Electrical spec for threshold/drive conversion. */
  electricalSpec: PinElectricalSpec;
}
```

When a partition has zero components, its backend compiler is not invoked
and no solver is instantiated. Pure digital and pure analog circuits are
degenerate partitions, not special cases.

**ID assignment is deferred to backends.** The partition contains
connectivity groups, not pre-assigned IDs. Each backend maps groups to its
own ID space:
- Digital: groups → sequential net IDs (for wiring table). Ground is not
  a concept.
- Analog: groups → MNA node IDs. The analog backend identifies Ground
  elements in its partition and assigns node ID 0 to their group. Other
  groups get sequential IDs starting from 1.

The bridge cross-reference map records `{ boundaryGroupId → digitalNetId,
analogNodeId }` after both backends have assigned IDs.

#### 4.5 Backend Compilers (simplified input)

The digital compiler (`src/engine/compiler.ts`) and analog compiler
(`src/analog/compiler.ts`) change their entry point to accept
`SolverPartition` instead of `Circuit`:

- **Digital compiler:** Receives `PartitionedComponent[]` with resolved pins
  and `ConnectivityGroup[]` with pin membership. It no longer calls
  `traceNets()` — connectivity is pre-computed. It still handles:
  multi-driver detection (shadow nets + bus resolver), SCC decomposition
  (Tarjan), topological sort (Kahn), wiring table construction, and
  evaluation order. These are digital-specific concerns.

- **Analog compiler:** Receives `PartitionedComponent[]` with resolved pins
  and `ConnectivityGroup[]`. It no longer calls `buildNodeMap()` —
  connectivity is pre-computed. It still handles: ground identification
  (node 0 assignment), internal node allocation (`getInternalNodeCount`),
  branch row allocation, MNA matrix sizing, factory invocation, topology
  validation (`detectWeakNodes`, `detectVoltageSourceLoops`), and bridge
  instance compilation from `crossEngineBoundaries`.

Both compilers internally map `ConnectivityGroup.groupId` → domain-local ID
as their first step. The rest of their logic is unchanged.

#### 4.6 CompiledCircuit (unified output)

```typescript
interface CompiledCircuit {
  /** Compiled digital domain (null if no digital components). */
  digital: CompiledDigitalDomain | null;
  /** Compiled analog domain (null if no analog components). */
  analog: CompiledAnalogDomain | null;
  /** Bridge adapters connecting the two domains. */
  bridges: BridgeAdapter[];
  /** Map from original circuit Wire → net/node ID for signal display. */
  wireSignalMap: Map<Wire, SignalAddress>;
  /** Map from component label → signal address for label-based I/O. */
  labelSignalMap: Map<string, SignalAddress>;
  /** Compilation diagnostics. */
  diagnostics: Diagnostic[];
}

/** Polymorphic signal address — works for both domains. */
type SignalAddress =
  | { domain: "digital"; netId: number; bitWidth: number }
  | { domain: "analog"; nodeId: number };
```

The `wireSignalMap` and `labelSignalMap` replace the current split between
`wireToNetId` (digital) and `wireToNodeId` (analog). Every wire and label
maps to a `SignalAddress` regardless of which domain it belongs to. The
editor binding, signal display, and label-based I/O all consume
`SignalAddress` without branching on domain.

---

## 5. Simulation Coordinator

### Current

- `SimulationEngine` (digital) and `AnalogEngine` are separate interface
  hierarchies.
- `MixedSignalCoordinator` is instantiated only for mixed circuits.
- The facade holds `_engine: DigitalEngine | AnalogEngine` and branches on
  which one is active.
- `app-init` has separate render loops, step logic, and signal access paths
  for analog and digital.

### Proposed

`SimulationCoordinator` is always instantiated. It is the only thing the
facade and app-init interact with.

```typescript
interface SimulationCoordinator extends Engine {
  /** Advance one full step across all active solver backends. */
  step(): void;

  /** Start continuous simulation across all backends. */
  start(): void;

  /** Stop all backends. */
  stop(): void;

  /** Read a signal by address (polymorphic across domains). */
  readSignal(addr: SignalAddress): SignalValue;

  /** Write an input signal by address. */
  writeSignal(addr: SignalAddress, value: SignalValue): void;

  /** Read a signal by component label. */
  readByLabel(label: string): SignalValue;

  /** Write an input signal by component label. */
  writeByLabel(label: string, value: SignalValue): void;

  /** Read all labeled signals (for postMessage API). */
  readAllSignals(): Map<string, SignalValue>;

  /** Access the digital backend (for micro-step, snapshots, etc.). Null if no digital domain. */
  readonly digitalBackend: SimulationEngine | null;

  /** Access the analog backend (for DC op, AC analysis, etc.). Null if no analog domain. */
  readonly analogBackend: AnalogEngine | null;

  /** Measurement observers are registered here, not on individual backends. */
  addMeasurementObserver(observer: MeasurementObserver): void;
  removeMeasurementObserver(observer: MeasurementObserver): void;
}
```

#### Stepping

When `step()` is called:

1. If only digital backend exists: `digitalBackend.step()`.
2. If only analog backend exists: `analogBackend.step()`.
3. If both exist:
   a. Read analog voltages at bridge input adapters → threshold → digital bits.
   b. Feed bits to digital backend, step it.
   c. Read digital outputs → update bridge output adapters.
   d. Step analog backend (bridge outputs stamp Norton equivalents).
   e. Check for threshold crossings; re-sync if needed.

This is exactly the current `MixedSignalCoordinator` flow, promoted to be the
standard path. Cases 1 and 2 are just case 3 with one backend absent — no
separate code paths.

#### Signal Value

```typescript
type SignalValue =
  | { type: "digital"; value: BitVector }
  | { type: "analog"; voltage: number; current?: number };
```

The editor binding, data table, timing diagram, and analog scope all consume
`SignalValue`. Each panel renders the variant it understands:

- `TimingDiagramPanel` renders digital signals as waveforms and analog signals
  as continuous traces (it already handles multi-bit digital; adding analog
  traces is a rendering concern, not an architectural one).
- `AnalogScopePanel` renders analog signals. Digital signals are shown as
  voltage levels (V_OH / V_OL from the bridge electrical spec).
- `DataTablePanel` shows both, formatted by type.

---

## 6. Facade Simplification

### Current

`DefaultSimulatorFacade` holds:
- `_engine: DigitalEngine | (AnalogEngine & SimulationEngine) | null`
- `_compiled: ConcreteCompiledCircuit | null`
- `_compiledAnalog: CompiledAnalogCircuit | null`
- `_dcOpResult: DcOpResult | null`
- `_clockManager: ClockManager | null`

And branches on which compiled result is non-null throughout.

### Proposed

```typescript
class DefaultSimulatorFacade implements SimulatorFacade {
  private _coordinator: SimulationCoordinator | null = null;
  private _compiled: CompiledCircuit | null = null;     // unified
  private _clockManager: ClockManager | null = null;

  compile(circuit: Circuit): SimulationCoordinator {
    const compiled = unifiedCompile(circuit, this._registry);
    const coordinator = new DefaultSimulationCoordinator(compiled);
    coordinator.init();

    this._compiled = compiled;
    this._coordinator = coordinator;
    this._clockManager = compiled.digital
      ? buildClockManager(compiled.digital)
      : null;

    return coordinator;
  }

  step(coordinator: SimulationCoordinator, opts?: StepOptions): void {
    if (opts?.advanceClocks && this._clockManager) {
      this._clockManager.advanceClocks(coordinator.digitalBackend!);
    }
    coordinator.step();
  }

  // Label-based I/O delegates to coordinator
  setInput(label: string, value: number): void {
    this._coordinator!.writeByLabel(label, /* ... */);
  }

  readOutput(label: string): SignalValue {
    return this._coordinator!.readByLabel(label);
  }
}
```

One compiled result. One coordinator. No branching on domain type.

---

## 7. App-Init Simplification

### Current

`app-init.ts` has ~15 branch points on `circuit.metadata.engineType` or
`facade.getCompiledAnalog() !== null`:

- Palette ordering/filtering
- `isAnalogOrMixed()` check before compilation
- Separate `compileAndBind()` paths for digital vs analog
- Separate render loop startup (`startAnalogRenderLoop` vs `startContinuousRun`)
- Separate signal access for timing diagram vs analog scope
- Separate step logic (digital microStep vs analog step)
- Separate DC op display logic
- Separate AC analysis menu visibility

### Proposed

- **Palette**: shows all components. No filtering. The component's model
  dropdown (in property panel) is how the user controls simulation fidelity.
- **Compilation**: one call to `facade.compile(circuit)`. Returns a
  `SimulationCoordinator`. No branching.
- **Render loop**: one loop. Calls `coordinator.step()`. No branching.
- **Signal display**: `EditorBinding` receives `CompiledCircuit.wireSignalMap`.
  For each wire, reads `coordinator.readSignal(addr)`. The renderer already
  handles signal-state coloring; it just needs to accept `SignalValue` instead
  of raw `number`.
- **Step button**: calls `coordinator.step()`. No branching. For digital-only
  micro-step mode, calls `coordinator.digitalBackend!.microStep()` (guarded
  by backend availability, not by circuit metadata).
- **Panels**: the data table and timing diagram are instantiated with
  `coordinator` and `compiled.labelSignalMap`. They read `SignalValue` and
  format by type. The analog scope is instantiated when
  `coordinator.analogBackend !== null`. This is one null check, not a mode
  branch.
- **DC operating point / AC analysis**: shown when
  `coordinator.analogBackend !== null`. Again, one null check.

---

## 8. Editor Binding

### Current

`EditorBinding` stores:
- `wireToNetId: Map<Wire, number>` (digital)
- `pinNetMap: Map<string, number>` (digital)

For analog circuits, a separate `wireSignalAccessAdapter` is used that reads
`wireToNodeId` from the compiled analog circuit.

### Proposed

`EditorBinding` stores:
- `wireSignalMap: Map<Wire, SignalAddress>` (from `CompiledCircuit`)
- `labelSignalMap: Map<string, SignalAddress>` (from `CompiledCircuit`)

Signal reading:
```typescript
getWireSignal(wire: Wire): SignalValue | null {
  const addr = this.wireSignalMap.get(wire);
  if (!addr) return null;
  return this.coordinator.readSignal(addr);
}
```

No branching on domain. The wire renderer receives a `SignalValue` and
colors accordingly — digital signals use HIGH/LOW/Z/UNDEFINED colors, analog
signals use voltage-gradient coloring. Both code paths already exist in
`WireRenderer`; they just need to be keyed on `SignalValue.type` instead of
on a global engine mode flag.

---

## 9. Headless Runner

### Current

`SimulationRunner` tracks `EngineRecord` discriminated by `engineType`:

```typescript
type EngineRecord =
  | { engineType: "digital"; engine: SimulationEngine; compiled: ConcreteCompiledCircuit }
  | { engineType: "analog"; engine: AnalogEngine; compiled: CompiledAnalogCircuit };
```

And branches on `engineType` for `setInput`, `readOutput`, `readAllSignals`.

### Proposed

`SimulationRunner.compile()` calls the unified compiler and returns a
`SimulationCoordinator`. The runner tracks:

```typescript
interface CompilationRecord {
  coordinator: SimulationCoordinator;
  compiled: CompiledCircuit;
}
```

Signal I/O delegates to `coordinator.readByLabel()` / `writeByLabel()`.
No branching.

---

## 10. MCP Server and PostMessage Adapter

Both consume the headless facade. Since the facade now returns a
`SimulationCoordinator` and uses `SignalValue`, these consumers get unified
for free:

- `circuit_compile` → returns success/failure + diagnostics (unchanged)
- `circuit_test` → test executor reads/writes via coordinator labels
  (unchanged contract, different internal plumbing)
- `digital-set-input` / `digital-read-output` postMessages → facade's
  `setInput(label, value)` / `readOutput(label)`, which delegate to
  coordinator. The postMessage type names don't change (they already don't
  say "digital-only").

---

## 11. Directory Structure

### Current

```
src/
  engine/           ← digital engine, compiler, compiled-circuit
  analog/           ← MNA engine, compiler, compiled-circuit, solver internals, bridge
  core/             ← shared types
  components/       ← all component definitions (already mixed)
```

### Proposed

```
src/
  core/             ← shared types, registry, pin, properties, circuit, element
  components/       ← all component definitions (unchanged)

  compile/          ← NEW: unified compilation front-end
    compile.ts          ← unifiedCompile() entry point
    partition.ts        ← netlist → solver partitions + bridge descriptors
    netlist.ts          ← unified net extraction (merged from engine/compiler + analog/node-map)
    types.ts            ← CompiledCircuit, SolverPartition, SignalAddress, BridgeDescriptor

  solver/           ← NEW: solver backends (peer directories)
    coordinator.ts      ← SimulationCoordinator (promoted MixedSignalCoordinator)
    bridge.ts           ← BridgeAdapter, threshold logic (from analog/bridge-adapter.ts)
    types.ts            ← SignalValue, SolverBackend interface

    digital/            ← current src/engine/ contents
      engine.ts
      compiler.ts           ← accepts SolverPartition, produces CompiledDigitalDomain
      compiled-circuit.ts
      clock-manager.ts

    analog/             ← current src/analog/ contents
      engine.ts             ← MNAEngine
      compiler.ts           ← accepts SolverPartition, produces CompiledAnalogDomain
      compiled-circuit.ts
      sparse-solver.ts
      newton-raphson.ts
      integration.ts
      dc-operating-point.ts
      ac-analysis.ts
      element.ts            ← AnalogElement interface
      ... (all MNA internals)

  editor/           ← unchanged (already engine-agnostic)
  headless/         ← facade, runner, builder (simplified)
  integration/      ← EditorBinding, SpeedControl (simplified)
  app/              ← app-init (simplified)
```

The key structural change: `engine/` and `analog/` become peer directories
under `solver/`, and the compilation front-end that reads the schematic and
partitions it lives in `compile/`, above both solvers.

---

## 12. What Does NOT Change

- **CircuitElement classes**: visual representation, pin declarations,
  `draw()` methods, `getBoundingBox()`, property handling. Untouched.
- **ExecuteFn implementations**: `executeAnd`, `executeDFlipflop`, etc. The
  function signatures and bodies are identical. Only their location in the
  `ComponentDefinition` moves from a top-level field to `models.digital.executeFn`.
- **AnalogFactory implementations**: stamp methods, nonlinear iteration,
  companion models. Untouched. Only the factory signature changes per
  pin-unification (positional → labeled), which is orthogonal to this work.
- **MNA solver internals**: sparse matrix, Newton-Raphson, timestep control,
  integration methods, DC operating point, AC analysis. Untouched.
- **Digital engine internals**: event queue, signal arrays, wiring tables,
  topological sort, SCC decomposition. Untouched.
- **Wire routing, hit testing, grid snapping, undo/redo**: untouched.
- **postMessage API message types**: unchanged. `digital-set-input` etc.
  keep their names.
- **Test vectors and test executor**: unchanged contract.
- **Component rendering and the `RenderContext` interface**: untouched.

---

## 13. Relationship to Pin Unification

The pin-unification plan (spec/pin-unification-plan.md) and this plan are
orthogonal and mutually reinforcing:

- **Pin unification** fixes how pin identity flows from declaration to
  compiler to factory to runtime. It changes the contract *within* each
  solver backend.
- **Unified component architecture** fixes how components, the compiler
  front-end, and the coordinator relate to each other. It changes the
  contract *between* solver backends and the rest of the system.

They can be implemented in either order or in parallel. Pin unification
is more surgical (changes factory signatures, compiler internals, resolver).
This plan is more structural (changes how the system is organized and how
data flows at the top level).

When both are complete:
- A component declares pins once (pinLayout, by label).
- A component declares models (digital, analog, etc.) as attributes.
- The compiler reads the schematic once, resolves pins by label, partitions
  by active model, and delegates to solver backends.
- Each backend receives labeled pins and a partition. No positional indexing,
  no engine-type tags, no mode switching.

---

## 14. Migration Strategy

### Phase 0: Complete node identity and current readout

**Goal**: prerequisite cleanup from the pin-unification work. No architectural
change — just finishing deferred items so the unified pipeline has clean inputs.

1. Rename `AnalogElement.nodeIndices` → `pinNodeIds`. Add `allNodeIds` field
   (`[...pinNodeIds, ...internalNodeIds]`). Update compiler `Object.assign`.
2. Update all consumers: `getElementPower` → `el.pinNodeIds[i]`,
   `getElementPinCurrents` 2-terminal check → `el.pinNodeIds.length === 2`,
   `detectWeakNodes` / `detectVoltageSourceLoops` / `_inferNodeCount` →
   `el.allNodeIds`.
3. Make `getPinCurrents` mandatory on `AnalogElement` (remove the `?`).
   Add implementations to any elements that still lack it (audit found
   `resistor.ts` and `capacitor.ts` have `getCurrent` but their
   `getPinCurrents` already exists — verify and remove `getCurrent`).
4. Remove `getCurrent` from the `AnalogElement` interface.
5. Remove the engine fallback cascade in `getElementPinCurrents` (the
   `nodeIndices.length === 2` → `[+I, -I]` manufacturing) and the power
   fallback in `getElementPower`.
6. Run full test suite.

**This phase is independently shippable.** It has no dependency on Phases 1–6
and can be done before, after, or in parallel with Phase 1.

### Phase 1: `models` bag on ComponentDefinition

**Goal**: new shape exists alongside old fields. Zero behaviour change.

1. Define `DigitalModel`, `AnalogModel`, `ComponentModels` types.
2. Add `models` field to `ComponentDefinition` (optional during migration).
3. In `register()`, auto-populate `models` from existing flat fields:
   ```typescript
   if (!def.models) {
     def.models = {};
     if (def.executeFn && def.executeFn !== noOpAnalogExecuteFn) {
       def.models.digital = { executeFn: def.executeFn, sampleFn: def.sampleFn, ... };
     }
     if (def.analogFactory) {
       def.models.analog = { factory: def.analogFactory, ... };
     }
   }
   ```
4. Add `hasDigitalModel()`, `hasAnalogModel()`, `availableModels()` utility
   functions.
5. Migrate `getByEngineType()` internals to use `models` presence.
6. Run full test suite.

**Component definitions are NOT changed yet.** The registry shimming ensures
backwards compatibility.

### Phase 2: Migrate component definitions

**Goal**: all ~150 component definitions use the `models` bag natively.

1. Mechanically rewrite each definition: move `executeFn` →
   `models.digital.executeFn`, `analogFactory` → `models.analog.factory`, etc.
2. Remove `noOpAnalogExecuteFn` — components without digital models simply
   omit `models.digital`.
3. Remove the flat fields from `ComponentDefinition` interface.
4. Remove the registry shimming from Phase 1.
5. Remove `engineType` from `ComponentDefinition`.
6. Add `defaultModel` to multi-model components.
7. Run full test suite.

### Phase 3: Unified netlist extraction and partitioning

**Goal**: one netlist pass replaces three (`traceNets`, `buildNodeMap`,
`partitionMixedCircuit`). See Section 4.2–4.5 for full design.

1. Write `extractConnectivityGroups(circuit, registry, modelAssignments)`:
   - Union-find on pin world positions + wire endpoints (single pass)
   - Tunnel merging by label
   - Domain tagging from model assignments
   - Width validation for groups with digital pins
   - Produces `ConnectivityGroup[]` with domain membership
2. Write `partitionByDomain(groups, components)`:
   - Splits components into digital and analog partitions
   - Identifies boundary groups (`domains.size > 1`)
   - Creates `BridgeDescriptor[]` at boundaries
   - Produces two `SolverPartition` objects
3. Adapt `flattenCircuit()` to use `activeModel` instead of `engineType`
   for same-vs-cross-domain classification.
4. Adapt digital compiler entry point: accept `SolverPartition`, map
   `ConnectivityGroup.groupId` → net IDs, then proceed with existing
   multi-driver detection, SCC decomposition, wiring table construction.
5. Adapt analog compiler entry point: accept `SolverPartition`, identify
   Ground group → node 0, map remaining groups → MNA node IDs, then
   proceed with existing internal node allocation, factory invocation,
   topology validation.
6. Build bridge cross-reference map after both backends assign IDs:
   `{ boundaryGroupId → digitalNetId, analogNodeId }`.
7. Produce unified `CompiledCircuit` with `wireSignalMap` and
   `labelSignalMap` (see Section 4.6).
8. Remove `detectEngineMode()`, `partitionMixedCircuit()`, `traceNets()`,
   and `buildNodeMap()`.
9. Run full test suite.

**This is the most complex phase.** It is tightly coupled with Phases 4–5
(they consume its output types). Plan Phases 3–5 as a unit; Phases 0–2
are independently shippable before this work begins.

### Phase 4: SimulationCoordinator

**Goal**: one coordinator replaces separate engine handling.

`SimulationCoordinator` is a **new class**, not a rename of
`MixedSignalCoordinator`. It wraps both backend engines and the bridge
cross-reference map, providing unified signal routing, label resolution,
and observer management. The existing `MixedSignalCoordinator` bridge-sync
logic (`syncBeforeAnalogStep`, `syncAfterAnalogStep`) is folded into the
new class's `step()` method.

1. Write `DefaultSimulationCoordinator` implementing `SimulationCoordinator`
   (interface defined in Section 5).
2. Fold `MixedSignalCoordinator` bridge-sync logic into `step()`.
3. Implement `readSignal(addr)`, `writeSignal(addr)`, `readByLabel(label)`,
   `writeByLabel(label)`, `readAllSignals()` using `CompiledCircuit`'s
   `labelSignalMap` and the bridge cross-reference map.
4. Handle degenerate cases (single backend) inside the coordinator, not
   in callers. When only one backend exists, bridge sync is a no-op.
5. Register `MeasurementObserver` on the coordinator, not on individual
   backends.
6. Facade returns `SimulationCoordinator` from `compile()`.
7. Runner's `compile()` returns `SimulationCoordinator`.
8. Remove `MixedSignalCoordinator` as a separate class.
9. Run full test suite.

### Phase 5: Simplify consumers

**Goal**: remove all analog-vs-digital branching from facade, runner,
app-init, editor binding.

1. Facade: remove `_compiled` / `_compiledAnalog` split → single
   `_compiled: CompiledCircuit`.
2. Runner: remove `EngineRecord` discriminated union → single record type.
3. EditorBinding: replace `wireToNetId` / `wireToNodeId` with
   `wireSignalMap: Map<Wire, SignalAddress>`.
4. App-init: remove all `if (engineType === 'analog')` and
   `if (getCompiledAnalog() !== null)` branches. One compilation path,
   one render loop, one signal access pattern.
5. Property panel: add `simulationModel` dropdown for multi-model components.
6. Remove `circuit.metadata.engineType`.
7. Run full test suite.

### Phase 6: Directory restructure

**Goal**: directory layout reflects the unified architecture.

1. Create `src/compile/` and `src/solver/`.
2. Move files. Update imports.
3. Single commit, mechanical change.
4. Run full test suite.

### Phase coupling and shipping strategy

| Phases | Coupling | Can ship independently? |
|--------|----------|----------------------|
| **Phase 0** | None — prerequisite cleanup | Yes. No dependency on Phases 1–6. |
| **Phases 1–2** | Internal only — registry refactor | Yes. Pure structural refactor, zero behaviour change. |
| **Phases 3–5** | Tightly coupled — 3 produces types that 4–5 consume | **No. Plan and execute as a single unit.** Phase 4 depends on Phase 3's `CompiledCircuit` and `SolverPartition` types. Phase 5 depends on Phase 4's `SimulationCoordinator`. |
| **Phase 6** | None — mechanical file moves | Yes. Do last, after everything else is stable. |

The recommended order is: Phase 0 (can overlap with 1–2) → Phases 1–2 →
Phases 3–5 (as a unit) → Phase 6.

---

## 15. Verification

After each phase:
- Full Vitest suite passes.
- Playwright E2E suite passes.
- Manual verification:
  - Pure digital circuit (AND gates + flip-flops) compiles and simulates.
  - Pure analog circuit (resistors + voltage source + ground) compiles and
    simulates.
  - Mixed circuit (AND gate in digital mode + resistor + voltage source)
    compiles with bridges and simulates.
  - Two AND gates on same schematic, one in digital model, one in analog
    model, both simulate correctly in their respective solvers with bridges.
  - Changing a component's active model from digital to analog (via property
    panel) and recompiling produces the correct solver partition.
  - Label-based I/O works across domain boundaries (set input on digital
    side, read output on analog side via bridge).

Phase 5 specifically:
- Confirm zero `engineType` references remain outside of backwards-compatible
  loader code.
- Confirm app-init has no analog-vs-digital branching.
- Confirm timing diagram displays both digital and analog signals from a
  mixed circuit.
