# Model System Unification

## Overview

The codebase has three independently-evolved systems for resolving which simulation model a component uses and which engine partition it belongs to. This spec unifies them into a single system built on two orthogonal axes:

1. **Component Model** — what happens inside the component (per-component, user-selectable)
2. **Digital Pin Loading** — where analog/digital bridge interfaces are placed (circuit-level, per-net overridable)

## Design Principles

1. There are exactly two simulation domains: **digital** (event-driven bit-vector engine) and **MNA** (Modified Nodal Analysis matrix solver). Everything that stamps into MNA is in the MNA domain regardless of fidelity.
2. A component model is: a fixed stamp topology (nodes + matrix positions) paired with a parameterized value function. Whether the stamps were hand-written, expanded from a subcircuit, or parsed from SPICE text is an authoring concern — the runtime is the same.
3. There is NO circuit-wide engine type. The compiler partitions by model domain, creating an engine per partition.
4. `simulationModel` selects which named model a component instance uses. Domain routing is derived from that choice.
5. Infrastructure/neutral components follow their connected nets.
6. Model resolution happens BEFORE flattening.
7. Bridge placement is a circuit-level concern, not a component model concern.

## Axis 1: Component Models

### The Model is a Stamp

Every MNA model, regardless of complexity, reduces to:
- **Stamp topology** — which MNA nodes it participates in (external pins + internal nodes), which matrix positions it writes to. Fixed at compile time.
- **Value function** — given current voltages and parameters, compute the numerical values at those positions. Called every NR iteration.
- **Parameter schema** — the configurable values (IS, N, gain, W/L, etc.) that affect the value function but never the topology.

A resistor stamps 4 matrix entries parameterized by G. An OpAmp stamps ~6 entries parameterized by gain and rOut. A CMOS AND subcircuit expansion stamps dozens of entries across multiple internal transistors. All are the same pattern at different scales.

### Named Models

Every model slot on a component has a name. The current `ComponentModels` has two implicit names (`digital` and `analog`) where `analog` is overloaded to contain both a behavioral factory AND a transistor model reference. This is replaced by explicitly named models.

**Current (overloaded):**
```typescript
interface ComponentModels {
  digital?: DigitalModel;
  analog?: AnalogModel;  // contains factory AND transistorModel AND pinElectrical
}
```

**New:**
```typescript
interface ComponentModels {
  digital?: DigitalModel;
  [name: string]: MnaModel;
}
```

In practice, implemented as:
```typescript
interface ComponentModels {
  digital?: DigitalModel;
  mnaModels?: Record<string, MnaModel>;
}
```

Where `MnaModel` is:
```typescript
interface MnaModel {
  /** Produces AnalogElementCore stamp objects for this component. */
  factory?: (
    pinNodes: ReadonlyMap<string, number>,
    internalNodeIds: readonly number[],
    branchIdx: number,
    props: PropertyBag,
    getTime: () => number,
  ) => AnalogElementCore;

  /** Named subcircuit in TransistorModelRegistry to expand instead of using factory. */
  subcircuitModel?: string;

  /** Number of internal MNA nodes needed. */
  getInternalNodeCount?: (props: PropertyBag) => number;

  /** Whether this model needs an MNA branch row (voltage sources, inductors). */
  requiresBranchRow?: boolean;

  /** Device type for SPICE parameter lookup (e.g., "NPN", "D", "NMOS"). */
  deviceType?: DeviceType;

  /** Default parameter values for this model. */
  defaultParams?: Record<string, number>;
}
```

Pin electrical specs (`pinElectrical`, `pinElectricalOverrides`) move OFF `MnaModel` — they are not an MNA concept. They describe bridge adapter behavior at digital/MNA boundaries: V_IH, V_IL, V_OH, V_OL, rIn, rOut. These belong on the component definition level, associated with the digital model's pins. They are currently on `AnalogModel` because the analog compiler creates the bridge adapters, but that's an implementation artifact.

Move to `ComponentDefinition`:
```typescript
interface ComponentDefinition {
  // ... existing fields ...
  /** Bridge adapter electrical specs for digital model pins. */
  pinElectrical?: PinElectricalSpec;
  /** Per-pin overrides for bridge adapter specs. */
  pinElectricalOverrides?: Record<string, PinElectricalSpec>;
}
```

No component currently sets these in its declaration — they are resolved at compile time from the logic family system (`resolvePinElectrical()` in `pin-electrical.ts:86`). The resolution priority is unchanged: per-pin override > component-level override > circuit-level logic family defaults. The compiler reads them from the component definition instead of from the MNA model.

### Example Declarations

**AND gate** — three named models:
```typescript
models: {
  digital: { executeFn: executeAnd, inputSchema: ["A", "B"], outputSchema: ["out"] },
  mnaModels: {
    behavioral: {
      factory: makeAndAnalogFactory(0),
    },
    cmos: {
      subcircuitModel: "CmosAnd2",
    },
  },
},
defaultModel: "digital",
```

**Resistor** — one MNA model:
```typescript
models: {
  mnaModels: {
    behavioral: {
      factory: createResistorElement,
    },
  },
},
defaultModel: "behavioral",
```

**NPN BJT** — one MNA model with SPICE parameters:
```typescript
models: {
  mnaModels: {
    behavioral: {
      factory: createBjtElement,
      deviceType: "NPN",
      defaultParams: BJT_NPN_DEFAULTS,
    },
  },
},
defaultModel: "behavioral",
```

**OpAmp** — two MNA models (ideal and real):
```typescript
models: {
  mnaModels: {
    ideal: { factory: createOpAmpElement },
    real: {
      factory: createRealOpAmpElement,
      getInternalNodeCount: () => 1,
      deviceType: "OPAMP",
    },
  },
},
defaultModel: "ideal",
```

### Model Resolution Chain

```typescript
export function getActiveModelKey(
  el: CircuitElement,
  def: ComponentDefinition,
): string {
  const prop = el.getAttribute('simulationModel');
  if (typeof prop === 'string' && prop.length > 0) {
    if (prop === 'digital' && def.models.digital) return prop;
    if (def.models.mnaModels?.[prop]) return prop;
    // Invalid key — hard error, not a silent fallback
    throw new Error(`Unknown simulationModel "${prop}" on ${el.instanceId}; valid keys: ${validKeys.join(', ')}`);
  }
  if (def.defaultModel !== undefined) return def.defaultModel;
  if (def.models.digital) return 'digital';
  const mnaKeys = Object.keys(def.models.mnaModels ?? {});
  if (mnaKeys.length > 0) return mnaKeys[0]!;
  throw new Error(`Component ${el.instanceId} (${def.typeId}) has no models`);
}

export function modelKeyToDomain(
  key: string,
  def: ComponentDefinition,
): "digital" | "mna" {
  if (key === 'digital' && def.models.digital) return 'digital';
  return 'mna';
}
```

### Invalid `simulationModel` Handling

When `simulationModel` is set to a key that doesn't exist:
1. `getActiveModelKey()` throws with the invalid key and the list of valid keys.
2. The compiler catches this and emits a diagnostic: `{ severity: "error", code: "invalid-simulation-model" }`.
3. Compilation fails. No silent fallback — the user must fix the property.

## Axis 2: Digital Pin Loading

### Circuit-Level Setting

Added to `CircuitMetadata`:
```typescript
digitalPinLoading?: "cross-domain" | "all" | "none";
```

- **`cross-domain`** (default, absent = this): Bridge adapters with pin electrical specs (rIn, rOut, V_IH, V_IL, V_OH, V_OL) at digital/MNA partition boundaries only. Digital-to-digital connections are ideal.
- **`all`**: Every digital-model component pin gets bridge adapters. All interconnect becomes MNA nodes. Full loading everywhere. This is what the current `logical` mode does, relocated from component to circuit.
- **`none`**: Bridges at partition boundaries use ideal conversion — infinite input impedance, ideal voltage source output. Logic levels convert (voltage threshold → bit, bit → voltage) but model no electrical loading.

### Per-Net Overrides

```typescript
// CircuitMetadata
digitalPinLoadingOverrides?: Array<{
  netId: string;       // stable net identifier
  loading: "loaded" | "ideal";
}>;
```

A user can override individual nets. `"loaded"` means full pin electrical modelling on that net regardless of circuit default. `"ideal"` means no loading on that net regardless of circuit default.

### How Bridge Synthesis Works Under Each Mode

**`cross-domain`**: The compiler partitions the circuit into digital and MNA groups. At each partition boundary, `synthesizeDigitalCircuit()` wraps the digital component and `makeBridgeInputAdapter()`/`makeBridgeOutputAdapter()` create the MNA interface elements with full pin electrical specs from the component definition.

**`all`**: Every digital-model component is treated as if it's at a partition boundary. The compiler wraps each one individually in bridge adapters. All wires become MNA nodes. The digital engine still evaluates the truth tables internally; the bridge adapters translate between MNA voltages and digital bits at every pin.

**`none`**: Same partition boundary detection as `cross-domain`, but bridge adapters use ideal parameters: rIn = Infinity (no input loading current), rOut = 0 (ideal voltage source), instantaneous threshold at V_IH/V_IL. Logic levels convert but impose no electrical load.

Per-net overrides apply after the circuit-level mode: if the circuit is `cross-domain` and a specific net is `"loaded"`, bridge adapters on that net use full pin electrical specs even if the net is between two digital components.

## Current Architecture — The Three Systems

### System 1: Unified Pipeline

- **Entry point:** `compileUnified()` (`src/compile/compile.ts:54`)
- **Property key:** `simulationModel`
- **Resolution:** `src/compile/extract-connectivity.ts:81-91` — `simulationModel prop > def.defaultModel > first model key`
- **Bootstrapping bug:** derives `derivedEngineType` by scanning for analog-only components (`compile.ts:96-111`), then passes it to `resolveModelAssignments` which triggers `forceAnalogDomain` override (`extract-connectivity.ts:96-101`)

### System 2: Analog Compiler

- **Entry point:** `compileAnalogCircuit()` (`src/solver/analog/compiler.ts:1190`) — private, not exported
- **Property key:** `simulationMode` (DIFFERENT from System 1)
- **Resolution:** `compiler.ts:834-836` — `simulationMode prop > (defaultModel == "digital" ? "logical" : "analog-pins")`
- **Contains redundant partitioner:** `extractDigitalSubcircuit()` (`compiler.ts:326-453`) — reimplements connectivity, union-find, and boundary detection

### System 3: Flattener

- **Entry point:** `resolveCircuitDomain()` (`src/solver/digital/flatten.ts:158`)
- **Property key:** `simulationMode`
- **Resolution:** type-level `hasDigitalModel`/`hasAnalogModel` predicates only — no per-instance override support
- **Runs before model resolution** — cannot respect `simulationModel` choices

### Five Divergent Infrastructure Type Sets

| # | Location | Differs By |
|---|----------|-----------|
| I1 | `src/compile/extract-connectivity.ts:21` | Includes Port |
| I2 | `src/compile/compile.ts:96` | Missing Port |
| I3 | `src/solver/analog/compiler.ts:287` | Includes In/Out, missing Wire/Port |
| I4 | `src/solver/analog/compiler.ts:680` | Identical to I3 |
| I5 | `src/solver/digital/compiler.ts:61` | Same as I1 |

## Known Bugs

### Bug B1: `netlist.ts:393` Reads Wrong Attribute

**File:** `src/headless/netlist.ts:393`
**Current:** `el.getAttribute('defaultModel')`
**Fix:** `el.getAttribute('simulationModel')`

### Bug B2: `simulationMode` vs `simulationModel` Key Split

The UI writes `simulationModel`. The analog compiler reads `simulationMode` at 5+ sites. They are different PropertyBag keys — the UI dropdown writes a value the analog compiler never reads.

| # | File:Line | Current Code |
|---|-----------|-------------|
| B2a | `src/solver/analog/compiler.ts:834` | `passAProps.has("simulationMode")` |
| B2b | `src/solver/analog/compiler.ts:937` | `passAProps.has("simulationMode")` |
| B2c | `src/solver/analog/compiler.ts:1286` | `props.has("simulationMode")` |
| B2d | `src/solver/analog/compiler.ts:2030` | `props.has("simulationMode")` |
| B2e | `src/solver/digital/flatten.ts:228` | `el.getAttribute("simulationMode")` |
| B2f | `src/solver/analog/compiler.ts:2559` | `key === "simulationMode"` filter |
| B2g | `src/solver/analog/compiler.ts:819,924` | diagnostic text references |
| B2h | 117 occurrences across 12 files | Various `simulationMode` references |

**Fix:** Rename all to `simulationModel`.

## What Gets Removed

### Dead Code Removal

| Code | Location | Reason |
|------|----------|--------|
| `derivedEngineType` bootstrapping | `compile.ts:96-129` | Replaced by per-component model resolution |
| `forceAnalogDomain` override | `extract-connectivity.ts:96-101` | Per-instance choice is authoritative |
| `resolveCircuitDomain()` | `flatten.ts:158-176` | Ran before model resolution; useless |
| `extractDigitalSubcircuit()` | `compiler.ts:326-453` | Redundant partitioner; `partitionByDomain` survives |
| `compileAnalogCircuit()` | `compiler.ts:1190-1930` | Private legacy path; `compileAnalogPartition` is the entry |
| `resolveCircuitInput()` | `compiler.ts:658-699` | Only called from `compileAnalogCircuit` |
| Infrastructure sets I2, I3, I4 | Various | Replaced by canonical I1 import |
| `SIMULATION_MODE_LABELS` | `property-panel.ts:23-27` | Replaced by model-name-based labels |
| `hasAnalogModel`/`hasDigitalModel` at heuristic sites | 15 sites (H1-H15) | Replaced by `getActiveModelKey()` + `modelKeyToDomain()` |

**Tests that exercise dead code must be rewritten or deleted.** Tests are not evidence of live code. Specifically:
- Tests using `simulationMode` property key → rewrite to use `simulationModel`
- Tests calling `compileAnalogCircuit` directly → rewrite to use `compileAnalogPartition` via `compileUnified`
- Tests for `extractDigitalSubcircuit` → delete (no dedicated tests exist; behavior covered by partition tests)
- Tests asserting `derivedEngineType` → rewrite to assert model assignments

### Single Canonical Infrastructure Set

Defined once in `src/compile/extract-connectivity.ts`, re-exported:

```typescript
export const INFRASTRUCTURE_TYPES = new Set([
  'Wire', 'Tunnel', 'Ground', 'VDD', 'Const', 'Probe',
  'Splitter', 'Driver', 'NotConnected', 'ScopeTrigger', 'Port',
]);
```

`In` and `Out` are NOT infrastructure — they are IO components with simulation models.

### Which Partitioner Survives

**Keep:** `partitionByDomain()` in `src/compile/partition.ts`
**Remove:** `extractDigitalSubcircuit()` in `src/solver/analog/compiler.ts:326-453`

| Criterion | `partitionByDomain` | `extractDigitalSubcircuit` |
|-----------|--------------------|-----------------------------|
| Input | Pre-computed connectivity + model assignments | Raw Circuit (re-does connectivity) |
| Output | `PartitionResult` + `BridgeDescriptor[]` | Ad-hoc partition + cut points |
| Tests | 20+ cases in `partition.test.ts` | None |
| Call sites | `compileUnified()` | `resolveCircuitInput()` (dead path) |

## Pipeline Ordering

**Current (broken):**
```
flatten → derive engineType → resolveModelAssignments → connectivity → partition → compile
```

**New:**
```
resolveModelAssignments → flatten (with resolved models) → connectivity → partition → compile
```

Changes to flatten:
1. `resolveCircuitDomain()` deleted.
2. `flattenCircuitScoped()` receives pre-resolved model assignments.
3. Cross-engine boundary detection uses `modelKeyToDomain(assignment)` instead of type-level predicates.
4. `simulationMode` read at `flatten.ts:228` replaced by model assignment lookup.

## Heuristic Sites (H1-H15)

All sites using `hasAnalogModel(def) && !hasDigitalModel(def)` or equivalent type-level predicates. Each rewritten to use `getActiveModelKey()` + `modelKeyToDomain()`.

| # | File:Line | Current Pattern | Rewrite |
|---|-----------|----------------|---------|
| H1 | `src/compile/compile.ts:105` | Derive `derivedEngineType` | Delete entire block |
| H2 | `src/app/menu-toolbar.ts:161` | Filter menu by analog-only | Use `getActiveModelKey()` on placed elements |
| H3 | `src/app/menu-toolbar.ts:366` | Gate context menu | Same as H2 |
| H4 | `src/app/test-bridge.ts:232` | `getCircuitDomain()` | Iterate elements, derive from resolved models |
| H5 | `src/app/canvas-popup.ts:84` | Panel visibility | Use `getActiveModelKey()` — already partially done |
| H6 | `src/compile/partition.ts:170` | Route neutral to analog | Route by connected net domain |
| H7 | `src/compile/partition.ts:195` | Route empty-model | Route by connected net domain |
| H8 | `src/compile/partition.ts:223` | Unknown key handling | Use `modelKeyToDomain()` — invalid keys are errors, not neutral |
| H9 | `src/solver/digital/flatten.ts:158-176` | `resolveCircuitDomain()` | Delete function |
| H10 | `src/solver/analog/compiler.ts:340` | `extractDigitalSubcircuit` | Delete function |
| H11 | `src/solver/analog/compiler.ts:690-691` | Mixed-mode detection | Delete with `resolveCircuitInput` |
| H12 | `src/solver/analog/compiler.ts:804-806` | Inline analog check (Pass A) | Use model assignments |
| H13 | `src/solver/analog/compiler.ts:909-912` | Inline analog check (partition Pass A) | Use model assignments |
| H14 | `src/solver/analog/compiler.ts:1276-1278` | Inline hasBothModels (Pass B) | Use `getActiveModelKey()` |
| H15 | `src/solver/analog/compiler.ts:2023-2025` | Same (partition Pass B) | Use `getActiveModelKey()` |

## Parallel Stream: UI

### Model Selector Dropdown

Replace `showSimulationModeDropdown()` in `property-panel.ts:261`:

**Current:** Shows `Object.keys(def.models)` → `["digital", "analog"]` with hardcoded labels `SIMULATION_MODE_LABELS`.

**New:** Shows all available model names from both `digital` and `mnaModels`:
```typescript
const modes: string[] = [];
if (def.models.digital) modes.push('digital');
for (const key of Object.keys(def.models.mnaModels ?? {})) modes.push(key);
```

Labels derived from model names with sensible defaults:
```typescript
const MODEL_LABELS: Record<string, string> = {
  digital: "Digital",
  behavioral: "Behavioral",
  cmos: "CMOS Transistor",
  ideal: "Ideal",
  real: "Real",
};
function getModelLabel(key: string): string {
  return MODEL_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
```

Dropdown hidden when only one model available (existing behavior preserved).

### Canvas Popup Panel Switching

`src/app/canvas-popup.ts:84-91` — replace `hasDigitalModel(def)` guard:

```typescript
const activeKey = getActiveModelKey(elementHit, def);
const domain = modelKeyToDomain(activeKey, def);

if (domain === 'digital') {
  // Show Pin Electrical panel (bridge interface parameters)
  const family = ctx.circuit.metadata.logicFamily ?? defaultLogicFamily();
  propertyPopup.showPinElectricalOverrides(elementHit, def, family);
} else {
  // Show SPICE Model Parameters panel if deviceType exists
  const mnaModel = def.models.mnaModels?.[activeKey];
  if (mnaModel?.deviceType) {
    propertyPopup.showSpiceModelParameters(elementHit, def);
  }
}
```

### Digital Pin Loading Menu

Add to Simulation menu (or circuit properties dialog):
- "Pin Loading: Cross-Domain" (default)
- "Pin Loading: All Pins"
- "Pin Loading: None"

Sets `circuit.metadata.digitalPinLoading`. Integrates with undo via existing metadata change mechanism.

### Per-Net Loading Override UI

- Right-click a wire → context menu includes "Pin Loading: Loaded / Ideal / Default"
- Select area → right-click → "Set Pin Loading" applies to all nets in selection
- Visual indicator on overridden wires/pins: small symbol at pin junction
  - `Z` or impedance icon = loaded (overridden to full loading)
  - `∞` or open icon = ideal (overridden to no loading)
  - No symbol = circuit default applies

### Pin Loading Indicator Rendering

Pin loading indicators render during the draw pass. For each pin where a per-net override is active, draw a small symbol at the pin position. Use `RenderContext` API — engine-agnostic, consistent with existing component rendering.

## Parallel Stream: Serialization

### Save Format (JSON)

Component properties already serialize via PropertyBag. `simulationModel` is already a PropertyBag key — no format change needed for model selection.

`SavedMetadata` additions:
```typescript
interface SavedMetadata {
  // ... existing fields ...
  digitalPinLoading?: "cross-domain" | "all" | "none";
  digitalPinLoadingOverrides?: Array<{
    anchor: { type: "label"; label: string } | { type: "pin"; instanceId: string; pinLabel: string };
    loading: "loaded" | "ideal";
  }>;
}
```

`engineType` field removed from `SavedMetadata`. Delete from save schema and all serialization/deserialization paths. Any `.dig`/`.json` files containing `engineType` will have it stripped on load — the field is dead.

### DTS Format

`DtsCircuit.attributes` stores `digitalPinLoading` and override anchors as JSON strings:
```
"digitalPinLoading": "cross-domain"
"digitalPinLoadingOverrides": "[{\"anchor\":{\"type\":\"label\",\"label\":\"CLK\"},\"loading\":\"loaded\"}]"
```

Model-related additions to `DtsDocument` (see "Storage and Serialization" under SPICE models):
- `modelDefinitions?: Record<string, DtsCircuit>` — subcircuit-based models
- `namedParameterSets?: Record<string, { deviceType: string; params: Record<string, number> }>` — named `.MODEL` parameter sets

### User-Supplied SPICE Models

The system already has most of the infrastructure for user-supplied SPICE models:

- **`.MODEL` parser** (`src/solver/analog/model-parser.ts`): Full SPICE `.MODEL` statement parser — handles multi-line continuations, inline comments, parenthesized parameter lists, scientific notation, SPICE multiplier suffixes (MEG, K, M, U, N, P, F). Parses into `ParsedModel { name, deviceType, level, params }`. Also handles multi-statement files via `parseModelFile()`.
- **`ModelLibrary`** (`src/solver/analog/model-library.ts`): Runtime storage for user-supplied `DeviceModel` objects with `add(model)`, `get(name)`, `getDefault(deviceType)`, `remove(name)`, `clear()`. Falls back to built-in SPICE defaults per device type.
- **`model-defaults.ts`**: Built-in SPICE Level 2 defaults for all 8 device types (D, NPN, PNP, NMOS, PMOS, NJFET, PJFET, TUNNEL) with full parameter sets.
- **`model-param-meta.ts`**: Parameter metadata (labels, units, descriptions) per device type for UI display.
- **`validateModel()`**: Validates parsed models against known parameter sets and supported levels.
- **SPICE panel** (`spec/spice-model-panel.md`): UI for viewing/editing per-instance parameter overrides stored as `_spiceModelOverrides` JSON in PropertyBag.
- **Compiler merge**: `_spiceModelOverrides` merged over `_modelParams` at compile time (`compiler.ts:1633, :2322`).

What's missing is the user-facing flow: importing a `.MODEL` card and attaching it to a component instance.

#### `.MODEL` Import Flow (Parameter Sets for Primitives)

For primitive devices (diode, BJT, MOSFET, JFET), a SPICE "model" is a parameter set applied to the existing factory equations. The flow:

1. **User action**: Right-click component → "Import SPICE Model" → paste or upload `.MODEL` text
2. **Parse**: `parseModelCard(text)` produces `ParsedModel { name, deviceType, level, params }`
3. **Validate**: `validateModel()` checks for unknown params and unsupported levels, emits diagnostics
4. **Store on instance**: The parsed params are serialized as `_spiceModelOverrides` JSON in the element's PropertyBag. The model name is stored as `_spiceModelName` for display purposes.
5. **Compile**: Existing compiler merge path applies overrides over defaults — no new compilation code needed.
6. **Display**: The SPICE panel shows the imported values. The model name appears in the property popup header.

This is entirely within existing infrastructure — the only new code is the UI import dialog.

#### `.SUBCKT` Import Flow (Composite Device Netlists)

For composite devices (OpAmp built from transistors, custom logic gates), a SPICE model is a subcircuit netlist. This requires new infrastructure.

**New: `.SUBCKT` Parser**

Add `parseSubcircuit()` to `model-parser.ts`:

```typescript
interface ParsedSubcircuit {
  name: string;
  ports: string[];          // external pin names in order
  elements: ParsedElement[];  // R1 1 2 1k, M1 d g s b NMOS W=10u L=1u, etc.
  models: ParsedModel[];    // inline .MODEL statements
  params: Record<string, number>;  // .PARAM defaults
}

interface ParsedElement {
  name: string;              // R1, M1, Q1, X1
  type: "R" | "C" | "L" | "D" | "Q" | "M" | "J" | "X" | "V" | "I";
  nodes: string[];           // node names
  value?: number;            // for R/C/L
  modelName?: string;        // for D/Q/M/J
  params?: Record<string, number>; // W=10u L=1u etc.
}
```

Format supported:
```spice
.SUBCKT myopamp inp inn out vcc vee
* Internal bias network
R1 inp  1   10k
R2 inn  2   10k
Q1 3 1 4 NPN
Q2 3 2 5 NPN
...
.MODEL NPN NPN(IS=1e-14 BF=200)
.ENDS myopamp
```

**Compilation Path**

1. **Parse**: `parseSubcircuit(text)` → `ParsedSubcircuit`
2. **Build Circuit**: Convert `ParsedSubcircuit` into a `Circuit` object:
   - Each `ParsedElement` maps to a registered component type (R→Resistor, Q→BJT, M→MOSFET, etc.)
   - Element nodes are mapped to internal wire connectivity
   - Port names map to In/Out elements at the subcircuit interface
   - Inline `.MODEL` params are stored as `_spiceModelOverrides` on each element
3. **Register**: Store the `Circuit` in `TransistorModelRegistry` under the subcircuit name
4. **Expand**: At compile time, `expandTransistorModel()` already handles the expansion — it maps interface In/Out elements to outer pin nodes, allocates internal nodes, and compiles each sub-element via its own factory

The key insight: `TransistorModelRegistry` already stores `Circuit` objects and `expandTransistorModel()` already compiles them. The CMOS gate models (`cmos-gates.ts`, `cmos-flipflop.ts`, `darlington.ts`) already use this exact path. A parsed `.SUBCKT` is just another `Circuit` produced from text instead of code.

**SPICE Element → Component Type Mapping**

| SPICE Prefix | Component Type | Notes |
|-------------|---------------|-------|
| R | Resistor | Value → resistance property |
| C | Capacitor | Value → capacitance property |
| L | Inductor | Value → inductance property |
| D | Diode | modelName → `_spiceModelOverrides` |
| Q | BJT (NPN/PNP) | modelName → `_spiceModelOverrides`, polarity from `.MODEL` type |
| M | MOSFET (NMOS/PMOS) | modelName → `_spiceModelOverrides`, W/L from params |
| J | JFET (NJFET/PJFET) | modelName → `_spiceModelOverrides` |
| V | DC Voltage Source | Value → voltage property |
| I | Current Source | Value → current property |
| X | Subcircuit instance | Recursive expansion |

#### Storage and Serialization

SPICE is an **import/export format**. Our native representation is the source of truth.

**Per-instance parameter overrides**: Already handled — `_spiceModelOverrides` JSON string (`Record<string, number>`) in PropertyBag, serialized via standard property serialization in both JSON and DTS formats. No schema changes needed. Works for both built-in defaults and user-imported `.MODEL` parameters.

**Subcircuit-based models** (composites like CMOS gates, user-imported `.SUBCKT`):

Stored as `Circuit` objects in the existing `subcircuitDefinitions` section of `DtsDocument` — the same format we already use for user subcircuits. No new serialization format needed.

Add to `DtsDocument`:
```typescript
interface DtsDocument {
  // ... existing fields ...
  /** Model subcircuit definitions keyed by model name (e.g., "CmosAnd2", "user_opamp_741"). */
  modelDefinitions?: Record<string, DtsCircuit>;
}
```

This mirrors `subcircuitDefinitions` but is semantically distinct — model definitions are expanded inline by the compiler, not instantiated as subcircuit elements.

**Named parameter sets** (user-imported `.MODEL` cards):

Add to `DtsDocument`:
```typescript
interface DtsDocument {
  // ... existing fields ...
  /** Named parameter sets keyed by model name (e.g., "1N4148", "2N2222"). */
  namedParameterSets?: Record<string, {
    deviceType: string;
    params: Record<string, number>;
  }>;
}
```

On load: populate `ModelLibrary` from `namedParameterSets`, build `Circuit` objects from `modelDefinitions` and register in `TransistorModelRegistry`.

On save: serialize the native representations. The original SPICE text is not preserved — if users need SPICE export, a separate export function regenerates `.MODEL`/`.SUBCKT` text from the native data.

**SPICE round-trip** (optional, for user convenience):

Store original SPICE source text as metadata alongside the native representation:
```typescript
// On the element's PropertyBag (optional, for display/export only):
_spiceSourceText?: string;  // original .MODEL or .SUBCKT text the user pasted
```

This is never read by the compiler — it's purely for the UI to show the original text and for SPICE export.

#### User Import UI

**For `.MODEL` (primitive parameter sets)**:
1. Right-click semiconductor component → "Import SPICE Model..."
2. Text area for pasting `.MODEL` card (or file upload)
3. Parse preview: show model name, device type, parameter count, any validation warnings
4. "Apply" stores params as `_spiceModelOverrides` on the instance and `_spiceModelName` for display
5. Also adds to `DtsDocument.namedParameterSets` so it persists and can be reused by other instances

**For `.SUBCKT` (composite device netlists)**:
1. Right-click component with `subcircuitModel` support → "Import SPICE Subcircuit..."
2. Text area for pasting `.SUBCKT` block
3. Parse preview: show name, port count, element count, any warnings
4. "Apply" registers the subcircuit and sets `simulationModel` to the subcircuit name on the instance
5. Stores as `DtsDocument.modelDefinitions` (native Circuit representation, not raw SPICE text)

**Circuit-level model library dialog**:
1. Menu → "SPICE Models..." opens a dialog listing all imported models
2. Shows `.MODEL` cards and `.SUBCKT` definitions with name, type, source
3. Add/edit/remove models
4. Models are available to all components in the circuit

## Subcircuit Propagation Rules

1. Model assignments are resolved on the top-level circuit first.
2. A subcircuit host element's `simulationModel` determines its own domain.
3. Internal circuits resolve models independently — no parent-to-child domain propagation.
4. Cross-engine boundary: when host domain differs from internal circuit's majority domain.
5. Same-domain subcircuits are inlined. Cross-domain subcircuits become opaque placeholders with bridge adapters.

## "Analog Wins" Label Precedence

At `src/compile/compile.ts:318-327`, when both digital and MNA compilers produce a label mapping for the same label, the MNA mapping wins. This is correct: neutral components (In, Out, Probe) appear in both partitions, and the MNA mapping to an actual solved voltage is authoritative. **Preserved unchanged.**

## Undo/Redo

- `simulationModel` changes go through `PropertyPanel.onPropertyChange` → existing undo system. No new infrastructure.
- `digitalPinLoading` metadata changes go through circuit metadata mutation → existing undo mechanism.
- Per-net loading overrides go through metadata mutation → same undo path.

## Per-Net Override Identity

Wires have no stable IDs — `Wire` is `{ start: Point, end: Point, bitWidth: number }`, recreated on every load. `ConnectivityGroup.groupId` is an ephemeral integer re-numbered every compile. Neither can serve as a stable anchor.

The stable anchors that survive save/load/recompile are:
- **`element.instanceId`** — UUID string, saved in both JSON and DTS formats, force-restored on deserialization (`dts-deserializer.ts:125`). Already used as the key in `pinSignalMap` (`compile.ts:271`) as `"${instanceId}:${pinLabel}"`.
- **Tunnel/Port labels** — user-assigned strings, persisted as element properties, used as the key in `labelSignalMap`.

### Two-Tier Stable Net ID Scheme

1. **Named nets** (have a Tunnel, Port, or labeled Probe): use the label string directly. Already exposed via `labelSignalMap`. Override stored as: `{ type: "label", label: "CLK", loading: "loaded" }`.

2. **Unnamed nets** (internal wiring): use `"instanceId:pinLabel"` of a canonical pin on the net. The canonical pin is determined by sorting `ConnectivityGroup.pins` by `(elementIndex, pinIndex)` ascending and taking the first entry. Override stored as: `{ type: "pin", instanceId: "abc-123", pinLabel: "out", loading: "ideal" }`.

### Implementation

Add a `stableNetId(group, elements)` helper in `src/compile/`:
```typescript
function stableNetId(
  group: ConnectivityGroup,
  elements: readonly CircuitElement[],
): string {
  // Check for tunnel/port/probe label first
  for (const pin of group.pins) {
    const el = elements[pin.elementIndex];
    if (el.typeId === 'Tunnel' || el.typeId === 'Port') {
      const label = el.getProperties().get('label');
      if (typeof label === 'string' && label.length > 0) return `label:${label}`;
    }
  }
  // Fall back to canonical pin (first by element index, then pin index)
  const sorted = [...group.pins]
    .map(pin => ({ ...pin, instanceId: elements[pin.elementIndex].instanceId }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId) || a.pinIndex - b.pinIndex);
  const canon = sorted[0];
  const el = elements[canon.elementIndex];
  const pinLabel = el.getPins()[canon.pinIndex]?.pinLabel ?? `pin${canon.pinIndex}`;
  return `pin:${el.instanceId}:${pinLabel}`;
}
```

Optionally emit `stableNetId` as a field on `ConnectivityGroup` during `extractConnectivityGroups()` to avoid re-sorting. Sort key is `(instanceId, pinLabel)` — both are stable across save/load.

### Override Resolution at Compile Time

1. After `extractConnectivityGroups()`, compute `stableNetId` for each group
2. Build a `Map<string, ConnectivityGroup>` keyed by stable net ID
3. For each override in `digitalPinLoadingOverrides`, look up the group by ID
4. If found, apply the loading mode to that group's partition boundary handling
5. If not found (element deleted, pin renamed), emit diagnostic: `{ code: "orphaned-pin-loading-override", severity: "warning" }`

### Storage in `CircuitMetadata`

```typescript
digitalPinLoadingOverrides?: Array<{
  anchor:
    | { type: "label"; label: string }
    | { type: "pin"; instanceId: string; pinLabel: string };
  loading: "loaded" | "ideal";
}>;
```

## Component Model Migration

Every component's `models` declaration transforms from the current `{ digital?, analog? }` to `{ digital?, mnaModels? }`. The transformation is mechanical per pattern and is executed via a codemod script.

### Codemod Approach

Wave 5 uses an `ast-grep` or `jscodeshift` codemod script that applies the 4 transform rules (B/C/D/E) mechanically. Pattern A files are no-ops (verified by the script finding no `analog:` key). The script is specified in advance with exact AST patterns — implementation agents run it, then verify the test suite passes.

**Codemod transform rules:**
1. **B/C** (MNA-only): `analog: { ...fields }` → `mnaModels: { behavioral: { ...fields } }`, add `defaultModel: "behavioral"`. `deviceType`, `defaultParams`, `getInternalNodeCount`, `requiresBranchRow` carry over unchanged.
2. **D** (dual, no transistorModel): `analog: { factory: X }` alongside `digital` → `mnaModels: { behavioral: { factory: X } }`. `defaultModel` unchanged (stays `"digital"`).
3. **E** (dual + transistorModel): `analog: { factory: X, transistorModel: Y }` → `mnaModels: { behavioral: { factory: X }, cmos: { subcircuitModel: Y } }`. `transistorModel` key renamed to `subcircuitModel` on `cmos` model.

**Edge cases requiring manual review after codemod:**
- Multi-export files: `src/components/pld/diode.ts` (3 exports), `src/components/library-74xx.ts` (2), `src/components/semiconductors/bjt.ts` (2: NPN/PNP), `src/components/semiconductors/mosfet.ts` (2: NMOS/PMOS)
- FET switching components: `fgpfet.ts`, `fgnfet.ts`, `nfet.ts`, `pfet.ts`, `trans-gate.ts`
- Separate analog fuse: `src/components/passives/analog-fuse.ts`

**Completion criterion:** `npm run test:q` passes with zero regressions. Grep for `analog:` within `models:` blocks across `src/components/` returns zero hits.

### Pattern A: Digital Only (no analog model)

~80 components: all arithmetic, most flip-flops (except D), most wiring, most memory, graphics, terminal, subcircuit, misc, PLD.

```typescript
// BEFORE
models: { digital: { executeFn, ... } }

// AFTER — unchanged
models: { digital: { executeFn, ... } }
```

No change needed. `mnaModels` absent = digital-only component.

### Pattern B: MNA Only with Factory (no deviceType)

~35 components: OpAmp, RealOpAmp, Resistor, Capacitor, PolarizedCap, Inductor, Potentiometer, Memristor, Crystal, Transformer, TappedTransformer, TransmissionLine, DcVoltageSource, AcVoltageSource, CurrentSource, VariableRail, VCVS, VCCS, CCCS, CCVS, OTA, Timer555, Comparator (active), Optocoupler, ADC, DAC, analog switches (SPST, SPDT), Schmitt triggers (Inverting, NonInverting), SCR, Triac, Diac, Triode, sensors (LDR, NTCThermistor, SparkGap).

```typescript
// BEFORE
models: {
  analog: {
    factory: createResistorElement,
  },
},

// AFTER
models: {
  mnaModels: {
    behavioral: {
      factory: createResistorElement,
    },
  },
},
defaultModel: "behavioral",
```

### Pattern C: MNA Only with Factory + DeviceType (semiconductors)

12 components: Diode, Zener, Schottky, Varactor, TunnelDiode, BJT(NPN), BJT(PNP), MOSFET(NMOS), MOSFET(PMOS), NJFET, PJFET. Note: BJT and MOSFET files each export two definitions (NPN/PNP, NMOS/PMOS).

```typescript
// BEFORE
models: {
  analog: {
    factory: createDiodeElement,
    deviceType: "D",
  },
},

// AFTER
models: {
  mnaModels: {
    behavioral: {
      factory: createDiodeElement,
      deviceType: "D",
    },
  },
},
defaultModel: "behavioral",
```

### Pattern D: Dual Model with Factory Only (digital + behavioral, no transistorModel)

~35 components. **IO**: Ground, VDD, LED, Probe, Clock, ButtonLED, SevenSeg, SevenSegHex. **Switching**: Switch, SwitchDT, Relay, RelayDT, Fuse. **Wiring**: Splitter, BusSplitter, Driver, DriverInv, Mux, Demux, Decoder. **Flipflops** (no transistorModel): DAsync, JK, JKAsync, RS, RSAsync, T, Monoflop. **Memory**: Counter, CounterPreset, Register.

```typescript
// BEFORE
models: {
  digital: { executeFn: executeLed, ... },
  analog: { factory: createLedAnalogElement },
},
defaultModel: "digital",

// AFTER
models: {
  digital: { executeFn: executeLed, ... },
  mnaModels: {
    behavioral: { factory: createLedAnalogElement },
  },
},
defaultModel: "digital",
```

### Pattern E: Dual Model with Factory + TransistorModel (gates + D-flipflop)

8 components: AND, NAND, OR, NOR, XOR, XNOR, NOT, D-flipflop.

```typescript
// BEFORE
models: {
  digital: { executeFn: executeAnd, inputSchema: ["A", "B"], outputSchema: ["out"] },
  analog: {
    factory: makeAndAnalogFactory(0),
    transistorModel: "CmosAnd2",
  },
},
defaultModel: "digital",

// AFTER
models: {
  digital: { executeFn: executeAnd, inputSchema: ["A", "B"], outputSchema: ["out"] },
  mnaModels: {
    behavioral: {
      factory: makeAndAnalogFactory(0),
    },
    cmos: {
      subcircuitModel: "CmosAnd2",
    },
  },
},
defaultModel: "digital",
```

The overloaded `analog` slot splits into two named models. `transistorModel` becomes `subcircuitModel` on the `cmos` model. The `behavioral` model keeps the factory. Both are separate `MnaModel` entries that the user can select between.

### Pattern F: Two MNA Models (OpAmp)

2 components: OpAmp (ideal) and RealOpAmp exist as separate component types today. Under the new system, they could be merged into one component with two named MNA models:

```typescript
models: {
  mnaModels: {
    ideal: { factory: createOpAmpElement },
    real: {
      factory: createRealOpAmpElement,
      getInternalNodeCount: () => 1,
    },
  },
},
defaultModel: "ideal",
```

OpAmp and RealOpAmp remain as separate component types in this spec. Merging them is a separate decision that does not block any work here. The named model system supports merging if desired later.

### `defaultModel` Values After Migration

| Pattern | Current `defaultModel` | New `defaultModel` |
|---------|----------------------|-------------------|
| A (digital only) | `undefined` or `"digital"` | `"digital"` (or omitted) |
| B (MNA only) | `undefined` | `"behavioral"` |
| C (MNA + deviceType) | `undefined` | `"behavioral"` |
| D (dual, no transistor) | `"digital"` | `"digital"` |
| E (dual + transistor) | `"digital"` | `"digital"` |

## Implementation Priority

| Wave | Work | Files | Risk | Tests |
|------|------|-------|------|-------|
| **0** | Fix B1 + B2 (mechanical rename) | `netlist.ts`, `compiler.ts`, `flatten.ts`, 117 occurrences across 12 files | Low | Existing tests pass with new key |
| **1** | `getActiveModelKey()`, `modelKeyToDomain()`, `MnaModel` interface, unified infrastructure set, move `pinElectrical`/`pinElectricalOverrides` from `AnalogModel` to `ComponentDefinition` | `registry.ts`, `extract-connectivity.ts`, `compile.ts`, `digital/compiler.ts` | Low | Unit tests for resolution chain and domain mapping |
| **2** | Pipeline reorder: models before flatten, delete `resolveCircuitDomain`, rewrite `flattenCircuitScoped` cross-engine check to use `modelKeyToDomain()` | `compile.ts`, `flatten.ts` | Medium | Subcircuit with per-instance override compiles correctly. Same-domain subcircuit inlines. Cross-domain subcircuit stays opaque. "Analog wins" label precedence: dual-partition label resolves to MNA mapping. |
| **3** | Delete dead code first, then rewrite tests. Delete: `extractDigitalSubcircuit`, `compileAnalogCircuit`, `resolveCircuitInput`, infrastructure sets I2-I4. Then rewrite: `analog-compiler.test.ts`, `lrcxor-fixture.test.ts`, `port-analog-mixed.test.ts`, `compile-analog-partition.test.ts`. | `compiler.ts`, `flatten.ts` | Medium | All analog tests pass via `compileAnalogPartition` |
| **4** | Rewrite H1-H15 to use new resolution | All heuristic site files | Medium | Mixed-circuit compile tests, partition tests |
| **5** | Restructure `ComponentModels` — named `mnaModels`, migrate all 144 component files (159 declarations) per patterns A-E | All component files | High | Component sweep tests, all compile tests |
| **6** | `digitalPinLoading` metadata + bridge synthesis driven by circuit setting | `compile.ts`, `compiler.ts`, `src/core/circuit.ts`, `save-schema.ts` | High | All three modes produce correct bridge adapter counts: `all` > `cross-domain` > `none` (zero loading stamps) |
| **7** | Model selector dropdown, canvas popup panel switching | `property-panel.ts`, `canvas-popup.ts` | Medium | E2E: dropdown shows named models, panel switches correctly |
| **8** | Pin loading menu UI, per-net override UI, visual indicators | `menu-toolbar.ts`, `src/editor/context-menu.ts`, `src/editor/wire-renderer.ts` | Medium | E2E: right-click wire, set loading, verify indicator |
| **9** | Save/load for `digitalPinLoading` + per-net overrides (tunnel + position anchors) | `save-schema.ts`, `save.ts`, `load.ts`, `dts-serializer.ts`, `dts-deserializer.ts` | Medium | Round-trip tests, orphaned override diagnostic test |
| **10** | `.SUBCKT` parser + subcircuit-to-Circuit builder | `src/solver/analog/model-parser.ts` (extend), new `src/io/spice-model-builder.ts` | Medium | Unit tests for parsing, element mapping, port mapping |
| **11** | SPICE import UI (`.MODEL` dialog, `.SUBCKT` dialog, circuit model library dialog) | new `src/app/spice-import-dialog.ts`, `src/app/canvas-popup.ts` (context menu entry) | Medium | E2E: import `.MODEL`, verify override applied; import `.SUBCKT`, verify expansion |
| **12** | SPICE model serialization in save/DTS formats | `save-schema.ts`, `dts-schema.ts`, `save.ts`, `load.ts`, `dts-serializer.ts`, `dts-deserializer.ts` | Medium | Round-trip: save circuit with imported models, reload, verify models present |

### Parallelization

- Waves 0-4 are sequential (each builds on the previous)
- Wave 5 (ComponentModels restructure) can start after Wave 4
- Waves 6-9 (pin loading) can proceed as a parallel track after Wave 4
- Waves 10-12 (SPICE import) can proceed as a parallel track after Wave 5 — depends on named `mnaModels` being in place
- The SPICE model panel spec (`spec/spice-model-panel.md`) is orthogonal and can proceed immediately

## Three-Surface Testing Requirements

Per `CLAUDE.md`, every user-facing feature must be tested across headless API, MCP tool, and E2E.

### Waves 0-1 (core resolution)
1. **Headless:** Unit tests for `getActiveModelKey()` (full chain, invalid key throws, infrastructure). Unit tests for `modelKeyToDomain()` — all model names.
2. **MCP:** `circuit_netlist` returns correct active model (B1 fix). `circuit_compile` handles analog circuits (B2 fix).
3. **E2E:** `component-sweep.spec.ts` validates dropdown key.

### Waves 2-4 (pipeline + heuristics)
1. **Headless:** Mixed-circuit compilation with per-instance model overrides. Subcircuit flattening with cross-engine boundaries from resolved models.
2. **MCP:** `circuit_compile` for mixed circuits returns both partitions.
3. **E2E:** Circuit with dual-model component, change model dropdown, verify correct partition.

### Wave 5 (ComponentModels restructure)
1. **Headless:** All existing component compile tests pass with new declaration format.
2. **MCP:** `circuit_describe` reflects named models.
3. **E2E:** Dropdown shows new model names.

### Wave 6 (digitalPinLoading)
1. **Headless:** Compile with each loading mode, verify bridge adapter presence/absence/parameters.
2. **MCP:** `circuit_compile` with `digitalPinLoading` metadata set.
3. **E2E:** Set loading mode via menu, verify simulation behavior changes.

### Waves 7-9 (UI + pin loading)
1. **Headless:** Compile with `digitalPinLoading` set to each mode. Verify bridge adapter count: `all` > `cross-domain` > `none` (zero loading stamps).
2. **MCP:** `circuit_compile` with metadata `digitalPinLoading: "all"`, verify all digital pins have bridge adapters.
3. **E2E:** Model selector shows named models. Pin loading menu changes mode. Right-click wire sets per-net override. Save/load preserves settings.

### Waves 10-12 (SPICE import)
1. **Headless:** `parseSubcircuit()` unit tests: valid `.SUBCKT` → `ParsedSubcircuit`. Element mapping tests: R/C/L/D/Q/M/J/V/I all map correctly. Subcircuit-to-Circuit builder produces compilable `Circuit`. Round-trip: import `.MODEL` card → compile → verify params applied.
2. **MCP:** `circuit_patch` to set `_spiceModelOverrides` from parsed `.MODEL` → `circuit_compile` → verify different simulation results.
3. **E2E:** Import `.MODEL` dialog → paste text → verify parse preview → apply → verify SPICE panel shows values. Import `.SUBCKT` → apply → verify compilation succeeds.

## Migration

### No Backward Compatibility
There are no external users. All callers are updated or the migration has failed.
- `simulationMode` property key: deleted everywhere. No dual-key reading, no fallback. Wave 0 renames all 117 occurrences across 12 files to `simulationModel`. Any code still reading `simulationMode` after Wave 0 is a bug.
- `SavedMetadata.engineType`: field deleted from schema. Removed from all serialization/deserialization paths. Stripped on load if present in old files.
- Old mode names (`logical`, `analog-pins`, `analog-internals`): deleted. Replaced by named model keys (`digital`, `behavioral`, `cmos`). No mapping layer.

### Component Declarations
All 144 component files (159 `models:` declarations) updated to use named `mnaModels` structure per patterns A-E documented in "Component Model Migration" section above. This is a mechanical transformation — no behavioral changes.

### Test Migration
- All 117 occurrences of `simulationMode` across 12 files → rename to `simulationModel`
- Tests calling `compileAnalogCircuit()` directly → rewrite to use `compileUnified()` or `compileAnalogPartition()` (affected files: `analog-compiler.test.ts`, `lrcxor-fixture.test.ts`, `port-analog-mixed.test.ts`, `compile-analog-partition.test.ts`)
- Tests asserting `derivedEngineType` → rewrite to assert per-component model assignments via `getActiveModelKey()`
- Tests for `extractDigitalSubcircuit` → delete (no dedicated tests exist; partition behavior covered by `partition.test.ts`)
- Tests referencing `SIMULATION_MODE_LABELS` or old mode names (`logical`, `analog-pins`, `analog-internals`) → rewrite to use named model keys (`digital`, `behavioral`, `cmos`)

## References

- `src/compile/compile.ts:54` — `compileUnified()` entry point
- `src/compile/compile.ts:96-129` — `derivedEngineType` bootstrapping (to be removed)
- `src/compile/compile.ts:318-327` — "MNA wins" label precedence (preserved)
- `src/compile/extract-connectivity.ts:21-24` — `INFRASTRUCTURE_TYPES` (canonical set)
- `src/compile/extract-connectivity.ts:57-118` — `resolveModelAssignments()` (to be rewritten)
- `src/compile/extract-connectivity.ts:96-101` — `forceAnalogDomain` (to be removed)
- `src/compile/extract-connectivity.ts:128-132` — `modelKeyToDomain()` (to be rewritten)
- `src/compile/partition.ts:100-307` — `partitionByDomain()` (surviving partitioner)
- `src/solver/analog/compiler.ts:287-290` — `NEUTRAL_TYPES_FOR_PARTITION` (to be deleted)
- `src/solver/analog/compiler.ts:326-453` — `extractDigitalSubcircuit()` (to be deleted)
- `src/solver/analog/compiler.ts:658-699` — `resolveCircuitInput()` (to be deleted)
- `src/solver/analog/compiler.ts:834-836` — `simulationMode` resolution (Bug B2)
- `src/solver/analog/compiler.ts:1190-1930` — `compileAnalogCircuit()` (to be deleted)
- `src/solver/analog/compiler.ts:1943-` — `compileAnalogPartition()` (surviving entry point)
- `src/solver/analog/transistor-model-registry.ts` — `TransistorModelRegistry` (preserved)
- `src/solver/analog/transistor-expansion.ts` — `expandTransistorModel()` (preserved)
- `src/solver/digital/flatten.ts:158-176` — `resolveCircuitDomain()` (to be deleted)
- `src/solver/digital/compiler.ts:61-64` — `COMPILE_INFRASTRUCTURE_TYPES` (replaced by import)
- `src/core/registry.ts:167-175` — `DigitalModel` interface
- `src/core/registry.ts:181-195` — `AnalogModel` interface (to be replaced by `MnaModel`)
- `src/core/registry.ts:201-206` — `ComponentModels` interface (to be restructured)
- `src/core/registry.ts:240-247` — `ComponentDefinition.defaultModel`
- `src/core/registry.ts:254-265` — `hasDigitalModel()`, `hasAnalogModel()`, `availableModels()` (delete after all H1-H15 heuristic sites are rewritten — no callers should remain)
- `src/app/canvas-popup.ts:84-91` — Panel switching (H5)
- `src/app/test-bridge.ts:228-234` — `getCircuitDomain()` (H4)
- `src/app/menu-toolbar.ts:161,366` — Menu domain detection (H2, H3)
- `src/editor/property-panel.ts:23-27` — `SIMULATION_MODE_LABELS` (to be replaced)
- `src/editor/property-panel.ts:261-299` — `showSimulationModeDropdown()` (to be rewritten)
- `src/headless/netlist.ts:393` — Bug B1
- `src/io/save-schema.ts:15-26` — `SavedMetadata`
- `src/io/dts-schema.ts:49-66` — `DtsCircuit`
- `src/solver/analog/model-defaults.ts` — SPICE parameter defaults
