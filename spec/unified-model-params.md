# Spec: Unified Model System

## Status: Ready for implementation

## Prerequisite: `spec/hot-loadable-spice-pin-params.md` (implemented)

## Problem

Model selection and parameterization are fragmented across 8 storage locations:

1. `ComponentDefinition.models.mnaModels` — inline factories
2. `ComponentDefinition.subcircuitRefs` — pointers to netlist names
3. `circuit.metadata.namedParameterSets` — values only, keyed by deviceType
4. `circuit.metadata.modelDefinitions` — subcircuit netlists
5. `circuit.metadata.subcircuitBindings` — pointer remapping
6. `SubcircuitModelRegistry` — runtime duplicate of #4
7. Per-element `_spiceModelOverrides`, `model`, `simulationModel` — values + selection keys
8. Analog factory registry — leaf factories for subcircuit expansion

The user sees one concept — "which model is this component using?" — but the system splits it across two selection properties (`simulationModel` for topology, `model` for params), multiple stores, and a compiler that reassembles the pieces.

## Design Principle

**Every user-facing model is a factory + a set of parameter values.** These two concepts are always paired. A `.MODEL` card is a trivial pairing (leaf factory + params). A `.SUBCKT` block is a composite pairing (netlist-derived factory + params). A user-selected "2N2222" and a user-imported subcircuit with parasitics appear in the same dropdown. The user doesn't distinguish topology from parameterization — both are just "the model."

**A factory defines the parameter schema; a model provides values.** The factory declares what params exist (paramDefs — names, types, units, ranks). A model is an instance of that schema with concrete values. Multiple models can share a factory (e.g. "behavioral" and "2N2222" both use `createBjtElement` with different param values).

## Design

### AnalogFactory — named type

Extract and name the factory signature from the current inline `MnaModel.factory`:

```typescript
// src/core/registry.ts
export type AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElementCore;
```

This is used in `ModelEntry` and replaces the anonymous inline signature on the old `MnaModel.factory`.

### ModelEntry — the unified type

```typescript
interface ParamDef {
  key: string;
  type: PropertyType;  // FLOAT for all model params; full PropertyType union for future extensibility
  label: string;
  unit?: string;
  description?: string;
  rank: "primary" | "secondary";
  min?: number;
  max?: number;
}

type ModelEntry =
  | { kind: "inline"; factory: AnalogFactory; paramDefs: ParamDef[]; params: Record<string, number> }
  | { kind: "netlist"; netlist: MnaSubcircuitNetlist; paramDefs: ParamDef[]; params: Record<string, number> };
```

- **`inline`**: The factory stamps directly into the MNA matrix. Used for behavioral models (resistor, diode, BJT, MOSFET, etc.). The factory reads params from the element's model param partition at construction time.
- **`netlist`**: The factory is derived by compiling the `MnaSubcircuitNetlist` at compile time via `compileSubcircuitToMnaModel()`. Used for user-imported `.SUBCKT` blocks or any model defined as a sub-circuit topology. The netlist data from `src/solver/analog/transistor-models/` is absorbed into component `modelRegistry` entries; those files are deleted.
- **`paramDefs`**: Always present on every ModelEntry. For inline models sharing a factory, all entries share the same paramDefs reference (the factory's canonical schema). For netlist models, paramDefs are derived from the subcircuit's parameter declarations at import time.
- **`params`**: Default values for this model variant. This is the authoritative source of defaults — not PropertyDefinition.defaultValue.

The compiler doesn't care about `kind` — it resolves both to a factory + params before calling. The distinction is mechanical (how the factory is obtained), not architectural.

**`ModelEntry` is MNA-only.** Digital models remain in `ComponentModels.digital` as before. The `model` property selects from `modelRegistry` keys + the implicit `"digital"` key when a digital model exists. This avoids needing a routing discriminant on `ModelEntry` — the compiler checks `model === "digital"` → event-driven engine; otherwise → resolve from `modelRegistry` → MNA engine.

### One model list per component

`ComponentDefinition` gets a unified `modelRegistry`:

```typescript
interface ComponentDefinition {
  // ... existing fields ...
  models: ComponentModels;       // retains .digital for event-driven engine
  modelRegistry: Record<string, ModelEntry>;  // MNA models only
  defaultModel: string;          // key into modelRegistry, or "digital"
}
```

This replaces `models.mnaModels` and `subcircuitRefs`. The `models.digital` field is retained for the event-driven engine. Every MNA model variant the user can select is an entry in `modelRegistry`.

**NPN BJT example:**
```typescript
const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,   description: "Forward current gain" },
    IS:  { default: 1e-14, unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,     description: "Forward emission coefficient" },
    BR:  { default: 1,     description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
    IKF: { default: Infinity, unit: "A", description: "Forward knee current" },
    IKR: { default: Infinity, unit: "A", description: "Reverse knee current" },
    ISE: { default: 0,     unit: "A", description: "B-E leakage saturation current" },
    ISC: { default: 0,     unit: "A", description: "B-C leakage saturation current" },
    NR:  { default: 1,     description: "Reverse emission coefficient" },
    VAR: { default: Infinity, unit: "V", description: "Reverse Early voltage" },
  },
});

modelRegistry: {
  "behavioral": {
    kind: "inline",
    factory: (pinNodes, internalNodeIds, branchIdx, props, getTime) =>
      createBjtElement(1, pinNodes, branchIdx, props),
    paramDefs: BJT_PARAM_DEFS,  // shared reference
    params: BJT_NPN_DEFAULTS,
  },
},
defaultModel: "behavioral",
```

**Resistor example:**
```typescript
modelRegistry: {
  "behavioral": {
    kind: "inline",
    factory: createResistorElement,
    paramDefs: RESISTOR_PARAM_DEFS,
    params: { resistance: 1000 },
  },
},
defaultModel: "behavioral",
```

**AND gate example (digital stays separate, CMOS in modelRegistry):**
```typescript
models: {
  digital: existingDigitalAndModel,  // event-driven engine — unchanged
},
modelRegistry: {
  "cmos": {
    kind: "netlist",
    netlist: CMOS_AND2_NETLIST,  // absorbed from former transistor-models/cmos-gates.ts
    paramDefs: CMOS_AND2_PARAM_DEFS,
    params: {},
  },
},
defaultModel: "digital",  // routes to models.digital
```

### One selection property

The element has one property: `model` (string). It indexes into the component's `modelRegistry` keys OR the implicit `"digital"` key. Replaces both `simulationModel` and the old `model` (named param set reference).

When `model === "digital"`, the compiler routes to the event-driven engine via `models.digital`. When `model` is any other value, the compiler looks up `modelRegistry[model]` and routes to the MNA engine.

When the user selects a MNA model (e.g. "2N2222") from the dropdown:
1. The model entry's `params` are written to the element's model param partition
2. `model` is set to `"2N2222"`

When the user selects "digital", the model param partition is cleared (digital models use static properties only).

### Partitioned PropertyBag

The PropertyBag is explicitly partitioned into static properties and model parameters:

- **Static properties** — label, bits, rotation, etc. Accessed via `props.get()` / `props.set()`. Persist across model switches. Defined by `ComponentDefinition.propertyDefs`.
- **Model parameters** — IS, BF, resistance, etc. Accessed via dedicated model param API. Wholesale-replaced on model switch. Defined by the active `ModelEntry.paramDefs`.

**API (added to `PropertyBag` in `src/core/properties.ts`):**

```typescript
getModelParam<T extends PropertyValue>(key: string): T;       // throws if absent
setModelParam(key: string, value: PropertyValue): void;
replaceModelParams(params: Record<string, PropertyValue>): void;  // wholesale replacement
getModelParamKeys(): string[];                                     // for iteration/serialization
hasModelParam(key: string): boolean;
```

Internal storage: a second `Map<string, PropertyValue>` alongside the existing static property map.

The full set of visible properties at any moment is `componentDef.propertyDefs + activeModelEntry.paramDefs`.

**Model switch** replaces the entire model param partition:
1. `replaceModelParams(newModelEntry.params)` — clears old, writes new defaults
2. Apply any user deltas (for undo/redo round-trips)

**Factories read model params directly:**
```typescript
const params = {
  IS: props.getModelParam<number>("IS"),
  BF: props.getModelParam<number>("BF"),
  // ...
};
```

Model params are **guaranteed populated** before the factory is called. No fallbacks, no `getOrDefault()` for model params. The compiler writes model defaults into the partition before invoking the factory.

### Model parameter defaults — single source of truth

`ModelEntry.params` is the authoritative source of default values for model parameters. `PropertyDefinition.defaultValue` is not used for model params.

Model-param PropertyDefs (ParamDefs) have `defaultSource: "model"` semantics, meaning:
- The property system resolves defaults from the active ModelEntry's `params`
- "Reset to default" on a model param resets to the active model entry's value
- The property panel shows "modified" indicators by comparing against the active model entry's value
- `PropertyDefinition.defaultValue` remains for non-model properties only (label, bits, etc.)

### `defineModelParams()` helper

Compact declaration that generates both the schema and the defaults from a single source:

```typescript
// src/core/registry.ts (or a new src/core/model-params.ts)
function defineModelParams(spec: {
  primary: Record<string, { default: number; unit?: string; description?: string; min?: number; max?: number }>;
  secondary?: Record<string, { default: number; unit?: string; description?: string; min?: number; max?: number }>;
}): { paramDefs: ParamDef[]; defaults: Record<string, number> };
```

**Usage:**
```typescript
const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-14,  unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,      description: "Forward emission coefficient" },
    BR:  { default: 1,      description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
  },
});
// BJT_PARAM_DEFS: ParamDef[] (schema with rank)
// BJT_NPN_DEFAULTS: { BF: 100, IS: 1e-14, NF: 1, BR: 1, VAF: Infinity } (values only)
```

### Compiler resolves ModelEntry to factory

The compiler's job simplifies to:

1. Read `model` property → if `"digital"`, route to event-driven engine (existing path)
2. Otherwise, look up `ModelEntry` in component's `modelRegistry` (static) or circuit's runtime registry (user-imported models). If `model` is absent/empty, use `def.defaultModel`.
3. If `kind === "inline"` → use the factory directly
4. If `kind === "netlist"` → compile via `compileSubcircuitToMnaModel()` → get factory. Leaf element factories are resolved from the component registry's `modelRegistry["behavioral"].factory` (replacing the old `getAnalogFactory()` lookup in `transistor-expansion.ts`).
5. `replaceModelParams(entry.params)` on the element's PropertyBag, then overlay any user-set deltas
6. Call factory — it reads model params via `props.getModelParam()`, guaranteed populated

No `_modelParams` injection. No `deviceType` gating. No multi-store resolution chain.

**Implementation notes:**

- **Branch counting:** `SubcircuitElement` has a static `branchCount?: number` field (already implemented). The compiler sums `subEl.branchCount ?? 0` to size the MNA matrix — it does not call factories with empty PropertyBag to probe for branch rows.
- **Pin resolution:** Pass B reads pin labels from `el.getPins()` (not `def.pinLayout`) so that dynamic power pins (VDD/GND on CMOS gates) flow through to subcircuit factories when wired by the user. This is already implemented.
- **Upstream compile pipeline:** `src/compile/partition.ts` and `src/compile/extract-connectivity.ts` currently call `modelKeyToDomain()` and `getActiveModelKey()`. These must be rewritten to use the new `model` property + `modelRegistry` lookup. This is part of T3.

### Runtime model registry (user-imported models)

When a user imports a `.MODEL` or `.SUBCKT`, a new `ModelEntry` is created and stored on the circuit:

```typescript
// circuit.metadata.models: Record<string, Record<string, ModelEntry>>
// Keyed by component type name (e.g. "NpnBJT"), then model name
```

**Runtime form** (in-memory on the circuit object): full `ModelEntry` with factory function refs. This is a runtime-only representation — function references are not serializable.

**`.MODEL` imports** (e.g. `.MODEL 2N2222 NPN(BF=200)`):
- Factory is copied from the component's default inline entry (e.g. `createBjtElement`)
- ParamDefs are shared — same reference as the default inline entry's paramDefs
- Params are the parsed values from the `.MODEL` card
- The import creates a new model (values), not a new factory (schema)

```typescript
circuit.metadata.models["NpnBJT"]["2N2222"] = {
  kind: "inline",
  factory: componentDef.modelRegistry["behavioral"].factory,
  paramDefs: componentDef.modelRegistry["behavioral"].paramDefs,
  params: { IS: 1e-14, BF: 200, NF: 1 },
};
```

**`.SUBCKT` imports** create a genuinely new factory with its own paramDefs derived from the subcircuit's parameter declarations:

```typescript
circuit.metadata.models["NpnBJT"]["BFR92A_parasitic"] = {
  kind: "netlist",
  netlist: parsedNetlist,
  paramDefs: derivedFromSubcktParams,  // new schema
  params: { Cpar: 1e-12, Lbond: 0.5e-9 },
};
```

The dropdown shows: component's static `modelRegistry` entries + `"digital"` (if available) + circuit's runtime entries for that component type.

### Serialization

**Factories are never serialized.** They are function references that live in source code.

**`circuit.metadata.models` has two forms:**
- **Runtime (in-memory):** full `ModelEntry` with factory refs and paramDef refs. The circuit object always holds the runtime form.
- **Serialized (`.dts` file):** factories and paramDefs stripped. For `inline` entries: `{ kind: "inline", params }`. For `netlist` entries: `{ kind: "netlist", netlist, paramDefs, params }`.

On save: the serializer projects runtime → serialized form (strips factory/paramDefs for inline).
On load: the deserializer rehydrates by looking up the component's static `modelRegistry` to restore factory and paramDefs for inline entries. Netlist entries carry their own paramDefs and compile to a factory at compile time.

**Per-element serialization saves deltas only:**
- `model: "2N2222"` — which model entry is active
- Only user-modified params (values that differ from the model entry's defaults)
- On load: apply model entry defaults, then overlay the delta

This means if a model entry's defaults are updated (e.g. library update), all instances pick up the new defaults except where the user explicitly overrode.

### Model switch undo

Model switch is implemented as a single `ModelSwitchCommand` (implements `EditCommand`):

```typescript
interface ModelSwitchCommand extends EditCommand {
  readonly elementId: string;
  readonly oldModelKey: string;
  readonly oldParamSnapshot: Record<string, PropertyValue>;
  readonly newModelKey: string;
  readonly newParamSnapshot: Record<string, PropertyValue>;
}
```

`execute()` writes `newModelKey` to the `model` property and calls `replaceModelParams(newParamSnapshot)`.
`undo()` writes `oldModelKey` and calls `replaceModelParams(oldParamSnapshot)`.

No generic `CompoundCommand` infrastructure needed — this is the only compound operation.

File location: `src/editor/model-switch-command.ts` (new file). Triggered from the property panel's model dropdown change handler in `src/editor/property-panel.ts`.

### Unified "Import Model" dialog

Single button "Import Model..." on every component with MNA models. One textarea, auto-detects format:

- `.MODEL` → parse params → create `ModelEntry` with factory + paramDefs copied from component's default entry, parsed values as params
- `.SUBCKT` → parse netlist → create `ModelEntry` with `kind: "netlist"`, paramDefs derived from subcircuit parameter declarations

After parsing a `.SUBCKT`, an assignment step lets the user designate which params are primary vs secondary. For `.MODEL` imports, rank is inherited from the factory's existing paramDefs.

The result is stored in the circuit's runtime model registry and applied to the current element.

### `deviceType` becomes import-boundary-only

Static lookup table in the parser/import module:

```typescript
const SPICE_TYPE_TO_COMPONENT: Record<string, string> = {
  NPN: "NpnBJT", PNP: "PnpBJT",
  NMOS: "NMOS", PMOS: "PMOS",
  NJFET: "NJFET", PJFET: "PJFET",
  D: "Diode", TUNNEL: "TunnelDiode",
  R: "Resistor", C: "Capacitor", L: "Inductor",
};
```

Parser's `VALID_DEVICE_TYPES` expands to include R/C/L/TUNNEL and remains parser-internal.

### Property panel

- Model dropdown at top — lists `modelRegistry` keys + `"digital"` (if available) + runtime entries
- Static properties (label, etc.) always shown
- Model params from active entry's paramDefs:
  - Primary params shown by default
  - Secondary params in collapsed "Advanced Parameters"
- Model param section rebuilds on model switch (paramDefs may differ between entries)
- Modified indicator on params that differ from the active model entry's defaults
- "Reset to default" resets to the active model entry's value
- No separate "SPICE Model Parameters" section
- If digital model selected → show digital-specific props (bits, propagation delay); model param section is empty/hidden

## Removed Concepts

| Concept | Replacement |
|---------|-------------|
| `models.mnaModels` | `modelRegistry` entries with `kind: "inline"` |
| `subcircuitRefs` | `modelRegistry` entries with `kind: "netlist"` |
| `simulationModel` property | `model` property (unified selection) |
| `_modelParams` sidecar | Model param partition on PropertyBag, read via `getModelParam()` |
| `_spiceModelOverrides` property | Individual model params in PropertyBag partition |
| `_spiceModelName` property | `model` property (unified selection) |
| `deviceType` on `MnaModel` | `SPICE_TYPE_TO_COMPONENT` at import boundary |
| `DeviceType` union | Parser-internal constant |
| `namedParameterSets` (circuit metadata) | `circuit.metadata.models` (unified runtime registry) |
| `modelDefinitions` (circuit metadata) | Same — folded into `circuit.metadata.models` |
| `subcircuitBindings` (circuit metadata) | Same — model selection is just the `model` property |
| `SubcircuitModelRegistry` singleton | Static entries in component `modelRegistry`; runtime entries in circuit metadata |
| `ModelLibrary` class | Replaced by direct registry lookup |
| `model-library.ts` file | Deleted |
| `subcircuit-model-registry.ts` file | Deleted |
| `model-param-meta.ts` file | Deleted — metadata superseded by `ParamDef` on each `ModelEntry` |
| `model-defaults.ts` file | Deleted — data absorbed into `defineModelParams()` calls in component files |
| `default-models.ts` file | Deleted — registration functions absorbed into component `modelRegistry` entries |
| `transistor-expansion.ts` file | Deleted — leaf factory lookup replaced by `modelRegistry` lookups during subcircuit compilation |
| `transistor-models/` directory | Deleted — CMOS/Darlington netlist data absorbed into component `modelRegistry` entries |
| `spice-subckt-dialog.ts` file | Deleted — folded into unified import dialog |
| `getActiveModelKey()` | Replaced by `model` property + `modelRegistry` lookup |
| `availableModels()` | Replaced by `Object.keys(modelRegistry)` + digital check |
| `hasAnalogModel()` | Replaced by `Object.keys(modelRegistry).length > 0` |
| `modelKeyToDomain()` | Replaced by `model === "digital"` check |
| `hasDigitalModel()` | Retained — still needed for `models.digital` check |
| Compiler `_modelParams` injection | Removed — compiler populates model param partition, factory reads directly |
| Separate "SPICE Model Parameters" panel | `rank: "secondary"` in collapsed panel |
| Two import buttons | Single "Import Model" with auto-detect |
| `model` + `simulationModel` (two properties) | Single `model` property |
| `PropertyDefinition.defaultValue` for model params | `ModelEntry.params` is authoritative via `defaultSource: "model"` semantics |

## No-Legacy Policy

**No shims, no fallback paths, no old-format handling.** There is no installed base of .dts files to migrate. If a deserializer encounters old-format fields, it should crash — fail loud, not silently convert.

**.dig files are external imports only.** Our own concepts (`simulationModel`, `_spiceModelOverrides`, etc.) must not appear in .dig import/export code. The handful of our own .dig files in `circuits/debug/` that carry these properties should be deleted and recreated in the new format if needed.

### Verification conditions (zero-occurrence checks)

After migration, the following must have **zero occurrences anywhere in the codebase**:

- `_spiceModelOverrides`
- `_modelParams`
- `_spiceModelName`
- `namedParameterSets`
- `modelDefinitions` (as circuit metadata field)
- `subcircuitBindings`
- `simulationModel` (as a property key string)
- `SubcircuitModelRegistry` (import or reference)
- `ModelLibrary` (import or reference)
- `DeviceType` (outside `src/solver/analog/model-parser.ts`)
- `models.mnaModels` (on ComponentDefinition)
- `ComponentDefinition.subcircuitRefs`
- `getActiveModelKey` (function name)
- `availableModels` (function name from registry)
- `modelKeyToDomain` (function name)
- `model-param-meta` (import path)
- `model-library` (import path)
- `subcircuit-model-registry` (import path)
- `default-models` (import path to `src/solver/analog/default-models.ts`)
- `transistor-expansion` (import path)
- `transistor-models` (import path)
- `spice-subckt-dialog` (import path)

**Grep protocol for T16:** For each symbol, run `grep -r "SYMBOL" src/ e2e/ scripts/`. For `DeviceType`, exclude `model-parser.ts`. Zero hits required for each.

## Migration

### Strategy: cut the poison first

Delete all old types and infrastructure first. Accept that everything breaks. Then rebuild. Tests come back online as components are migrated — the test suite going from red to green IS the progress tracker.

**No dual-path compiler.** No temporary compatibility shims. Old code is deleted before new code is written. Agents cannot defer work by pointing at "obviously intended cleanup" because there is nothing old left to defer to.

### Test rules

**Fixture rule:** All test files must import model entries, paramDefs, and PropertyBag construction from shared fixture modules in `src/test-fixtures/model-fixtures.ts`. Inline construction of `ModelEntry` or `ParamDef` objects in individual test files is prohibited. This ensures shape changes propagate from a single source.

**Three-surface rule (from CLAUDE.md):** Every user-facing feature must be tested across headless API, MCP tool, and E2E surfaces. Wave 4 features (runtime registry, delta serialization, import dialog, model dropdown) each require all three surfaces.

### Wave 1: New types + delete old infrastructure

**State after wave: nothing compiles. That's the point.**

#### T1: Add new types

**Files to create/modify:**
- `src/core/registry.ts` — add `AnalogFactory` type, `ParamDef` interface, `ModelEntry` union, `modelRegistry` and `defaultModel` fields on `ComponentDefinition`
- `src/core/properties.ts` — add `getModelParam()`, `setModelParam()`, `replaceModelParams()`, `getModelParamKeys()`, `hasModelParam()` to `PropertyBag`; second internal `Map` for model param partition
- `src/core/model-params.ts` (new) — `defineModelParams()` helper
- `src/test-fixtures/model-fixtures.ts` (new) — shared test fixtures: sample `ModelEntry` objects, `ParamDef` arrays, `PropertyBag` construction helpers

**Tests (`src/core/__tests__/model-params.test.ts`, `src/core/__tests__/property-bag-partition.test.ts`):**
- `defineModelParams()` returns `{ paramDefs, defaults }` with correct rank assignment
- `getModelParam()` returns value from model partition
- `setModelParam()` writes to model partition, not static partition
- `replaceModelParams()` clears old partition, writes new values
- `getModelParamKeys()` returns only model param keys
- Static `get()`/`set()` are unaffected by model param operations

#### T2: Delete all old infrastructure

**Every item below is a deletion.** The agent must grep for each deleted symbol and delete ALL references — the table below lists known locations but is not exhaustive. If a grep reveals additional references, delete them too.

| Delete | Known locations |
|--------|----------------|
| `models.mnaModels` field | `src/core/registry.ts` (`ComponentModels` interface) |
| `subcircuitRefs` field | `src/core/registry.ts` (`ComponentDefinition`) |
| `MnaModel.deviceType` field | `src/core/registry.ts` |
| `DeviceType` union | `src/core/analog-types.ts` → move to `src/solver/analog/model-parser.ts` as parser-internal |
| `getActiveModelKey()` | `src/core/registry.ts` (definition); `src/compile/extract-connectivity.ts`, `src/compile/partition.ts`, `src/app/canvas-popup.ts`, `src/app/test-bridge.ts` (callers) |
| `availableModels()` | `src/core/registry.ts` (definition); `src/app/canvas-popup.ts`, `src/editor/property-panel.ts` (callers) |
| `hasAnalogModel()` | `src/core/registry.ts` (definition + callers) |
| `modelKeyToDomain()` | `src/core/registry.ts` (definition); `src/compile/partition.ts`, `src/compile/extract-connectivity.ts`, `src/app/canvas-popup.ts`, `src/app/menu-toolbar.ts`, `src/app/test-bridge.ts` (callers) |
| `_modelParams` injection block | `src/solver/analog/compiler.ts` (~lines 1364-1378) |
| `_spiceModelOverrides` PropertyDef | All 11 semiconductor files in `src/components/semiconductors/` |
| `_spiceModelName` PropertyDef | Same semiconductor files |
| `simulationModel` attribute maps | All 7 gate files + `src/components/flipflops/d.ts` |
| `model-library.ts` | `src/solver/analog/model-library.ts` — delete entire file. Callers: `compiler.ts`, `src/app/spice-import-dialog.ts`, `src/io/dts-deserializer.ts` |
| `subcircuit-model-registry.ts` | `src/solver/analog/subcircuit-model-registry.ts` — delete entire file. Callers: `compiler.ts`, `src/compile/compile.ts`, `src/io/dts-serializer.ts`, `src/io/dts-deserializer.ts`, `src/app/spice-model-apply.ts`, `src/app/spice-model-library-dialog.ts`, `src/app/canvas-popup.ts` |
| `model-param-meta.ts` | `src/solver/analog/model-param-meta.ts` — delete entire file. Caller: `src/editor/property-panel.ts` |
| `model-defaults.ts` | `src/solver/analog/model-defaults.ts` — delete entire file. Callers: all semiconductor component files that import defaults |
| `default-models.ts` | `src/solver/analog/default-models.ts` — delete entire file. Callers: `src/headless/default-facade.ts`, `src/app/canvas-popup.ts`, `src/app/spice-model-library-dialog.ts` |
| `transistor-expansion.ts` | `src/solver/analog/transistor-expansion.ts` — delete entire file. Callers: `compiler.ts`, component registration files |
| `transistor-models/` directory | `src/solver/analog/transistor-models/` — delete entire directory (`cmos-gates.ts`, `cmos-flipflop.ts`, `darlington.ts`). Callers: `default-models.ts` (already deleted) |
| `spice-subckt-dialog.ts` | `src/app/spice-subckt-dialog.ts` — delete entire file. Caller: `src/app/canvas-popup.ts` |
| `namedParameterSets` field | `src/core/circuit.ts` (`CircuitMetadata`); `src/io/dts-deserializer.ts`, `src/io/dts-serializer.ts`, `src/app/spice-model-apply.ts`, `src/app/spice-model-library-dialog.ts` |
| `modelDefinitions` field | `src/core/circuit.ts` (`CircuitMetadata`); `src/io/dts-deserializer.ts`, `src/io/dts-serializer.ts`, `src/app/spice-model-apply.ts`, `src/app/spice-model-library-dialog.ts` |
| `subcircuitBindings` field | `src/core/circuit.ts` (`CircuitMetadata`); `src/io/dts-deserializer.ts` |
| Old `.dig` files | `circuits/debug/4-1-mux-2-bit-selector-routes-one-of-four-inputs.dig`, `circuits/debug/sr-latch-from-nand-gates-set-hold-reset.dig` |
| All test files for deleted infrastructure | `src/solver/analog/__tests__/model-library.test.ts`, `src/solver/analog/__tests__/model-param-meta.test.ts`, `src/solver/analog/__tests__/spice-subckt-dialog.test.ts`, `src/solver/analog/__tests__/spice-model-library.test.ts`, `src/solver/analog/__tests__/cmos-flipflop.test.ts`, `src/solver/analog/__tests__/cmos-gates.test.ts`, `src/solver/analog/__tests__/darlington.test.ts`, `src/io/__tests__/dts-model-roundtrip.test.ts` |

**Agent instruction:** After completing all listed deletions, run `grep -r` for every symbol in the verification conditions list. Delete any remaining references found. The goal is: only the new types from T1 and the as-yet-unmigrated `mnaModels` references on the 80 component files remain (those are addressed in Wave 3).

### Wave 2: Core machinery + BJT reference implementation

**State after wave: BJT tests pass end-to-end. Compiler proven against a real component.**

#### T3: Compiler — ModelEntry resolution

**Files to modify:**
- `src/solver/analog/compiler.ts` — rewrite model resolution to use `modelRegistry`; remove `ModelLibrary`/`SubcircuitModelRegistry` params; leaf factory lookup uses component registry instead of `getAnalogFactory()`
- `src/compile/partition.ts` — replace `modelKeyToDomain()` calls with `model === "digital"` check
- `src/compile/extract-connectivity.ts` — replace `getActiveModelKey()` calls with `model` property read + `modelRegistry` lookup
- `src/compile/compile.ts` — remove `SubcircuitModelRegistry` param; update call signatures

New-only path (no old path exists to fall back to):
1. Read `model` property → if `"digital"`, route to event-driven engine (existing `models.digital` path)
2. If `model` is absent/empty, use `def.defaultModel`
3. Look up `ModelEntry` in component's `modelRegistry` (static) or circuit's runtime registry
4. If `inline` → use factory directly
5. If `netlist` → compile via `compileSubcircuitToMnaModel()`, resolving leaf factories from component registry `modelRegistry["behavioral"].factory`
6. `replaceModelParams(entry.params)` then overlay user deltas
7. Call factory — reads `getModelParam()`, guaranteed populated

**Agent condition:** T3 must be immediately followed by T4 using the same agent. The compiler cannot be tested without a real component. Do not stop between T3 and T4. T3 is not complete until T4's tests pass.

#### T4: BJT reference implementation

**Files to modify:**
- `src/components/semiconductors/bjt.ts` — declare `modelRegistry` on `NpnBjtDefinition` / `PnpBjtDefinition` with `"behavioral"` entry; declare BJT params via `defineModelParams()` using all 11 params from the old `BJT_NPN_DEFAULTS`/`BJT_PNP_DEFAULTS`; factory reads `props.getModelParam()` per param

**Tests (`src/components/semiconductors/__tests__/bjt.test.ts`):**
- BJT with default params compiles and simulates: Vbe=0.65V produces expected Ic within convergence tolerance
- `getModelParam("BF")` on compiled element returns 100
- `setModelParam("BF", 200)` + recompile produces different Ic
- Use shared fixtures from `src/test-fixtures/model-fixtures.ts`

**Agent condition:** Same agent as T3. Must run `npm run test:q` and confirm BJT tests pass before completing.

#### T5: Property panel — model-aware display

**Files to modify:**
- `src/editor/property-panel.ts` — reads `paramDefs` from active model entry; rebuilds param section on model switch; model dropdown from `modelRegistry` keys + `"digital"` + runtime entries; modified indicators; "Reset to default"; remove `getParamMeta` import (deleted file)

*Parallel with T6 once T3+T4 complete.*

#### T6: dts serializer/deserializer

**Files to modify:**
- `src/io/dts-schema.ts` — replace `namedParameterSets`, `modelDefinitions`, `subcircuitBindings` with `models` field on `DtsDocument`; add per-element `modelParamDeltas` field on `DtsElement`
- `src/io/dts-serializer.ts` — serialize `circuit.metadata.models` (runtime → serialized projection); write per-element deltas; remove `SubcircuitModelRegistry` import
- `src/io/dts-deserializer.ts` — deserialize `circuit.metadata.models` (rehydrate factory/paramDefs from component registry); apply per-element deltas; crash on old-format fields (`namedParameterSets`, `modelDefinitions`, `subcircuitBindings`); remove `ModelLibrary`/`SubcircuitModelRegistry` imports

**Tests (`src/io/__tests__/dts-model-roundtrip.test.ts` — rewritten):**
- Round-trip: circuit with `circuit.metadata.models["NpnBJT"]["2N2222"]` → serialize → deserialize → `params.BF === 200`
- Round-trip: element with `model: "2N2222"` and user delta `BF: 250` → serialize → deserialize → `getModelParam("BF") === 250`
- Crash test: document with `namedParameterSets` key throws on deserialize

*Parallel with T5 once T3+T4 complete.*

**POST-WAVE CHECK (orchestrator-mandated):** Run `npm run test:q`. BJT tests pass. Capture failing test count — expected: all non-BJT component tests fail (80 component files unmigrated). Confirm `compiler.ts`, `partition.ts`, `extract-connectivity.ts`, `properties.ts`, `property-panel.ts` compile clean.

### Wave 3: Component sweep

**State after wave: full test suite passes.**

All tasks parallel. Each is a mechanical repetition of the BJT pattern from T4. Each task's agent should reference `src/components/semiconductors/bjt.ts` as the template.

For every component: replace `mnaModels` with `modelRegistry`, use `defineModelParams()` for components that have model params, factory reads `getModelParam()`. Components with only a single trivial model (e.g. a voltage source with no user-tunable params) still get a `modelRegistry` with one `"behavioral"` entry.

#### T7: Remaining semiconductors (12 files)
- `src/components/semiconductors/diode.ts`
- `src/components/semiconductors/mosfet.ts` (NMOS + PMOS definitions)
- `src/components/semiconductors/njfet.ts`
- `src/components/semiconductors/pjfet.ts`
- `src/components/semiconductors/zener.ts`
- `src/components/semiconductors/schottky.ts`
- `src/components/semiconductors/tunnel-diode.ts`
- `src/components/semiconductors/scr.ts`
- `src/components/semiconductors/diac.ts`
- `src/components/semiconductors/triac.ts`
- `src/components/semiconductors/triode.ts`
- `src/components/semiconductors/varactor.ts`

These have `_spiceModelOverrides`/`_modelParams` patterns. Factory reads `getModelParam()`. Param keys come from the old `model-defaults.ts` constants (now deleted — agent must derive from the factory's param reads in each component file).

#### T8: Passives (10 files)
- `src/components/passives/resistor.ts`
- `src/components/passives/capacitor.ts`
- `src/components/passives/inductor.ts`
- `src/components/passives/crystal.ts`
- `src/components/passives/memristor.ts`
- `src/components/passives/polarized-cap.ts`
- `src/components/passives/potentiometer.ts`
- `src/components/passives/tapped-transformer.ts`
- `src/components/passives/transformer.ts`
- `src/components/passives/transmission-line.ts`

#### T9: Gates (7 files)
- `src/components/gates/and.ts`
- `src/components/gates/or.ts`
- `src/components/gates/nand.ts`
- `src/components/gates/nor.ts`
- `src/components/gates/xor.ts`
- `src/components/gates/xnor.ts`
- `src/components/gates/not.ts`

Each gate retains `models.digital` for the event-driven engine. The `modelRegistry` contains a `"cmos"` entry with `kind: "netlist"`, with the netlist data absorbed from the deleted `transistor-models/cmos-gates.ts`. Remove `subcircuitRefs` and `simulationModel` attribute maps.

#### T10: Flip-flops (7 files)
- `src/components/flipflops/d.ts`
- `src/components/flipflops/d-async.ts`
- `src/components/flipflops/jk.ts`
- `src/components/flipflops/jk-async.ts`
- `src/components/flipflops/rs.ts`
- `src/components/flipflops/rs-async.ts`
- `src/components/flipflops/t.ts`

`d.ts` has both `models.digital` and `subcircuitRefs` — gets `modelRegistry` with CMOS netlist from deleted `transistor-models/cmos-flipflop.ts`. Others get `modelRegistry` with behavioral MNA entries.

#### T11: Active components (14 files)
- `src/components/active/adc.ts`
- `src/components/active/analog-switch.ts`
- `src/components/active/cccs.ts`
- `src/components/active/ccvs.ts`
- `src/components/active/comparator.ts`
- `src/components/active/dac.ts`
- `src/components/active/opamp.ts`
- `src/components/active/optocoupler.ts`
- `src/components/active/ota.ts`
- `src/components/active/real-opamp.ts`
- `src/components/active/schmitt-trigger.ts`
- `src/components/active/timer-555.ts`
- `src/components/active/vccs.ts`
- `src/components/active/vcvs.ts`

#### T12: Sources + sensors (7 files)
- `src/components/sources/ac-voltage-source.ts`
- `src/components/sources/current-source.ts`
- `src/components/sources/dc-voltage-source.ts`
- `src/components/sources/variable-rail.ts`
- `src/components/sensors/ldr.ts`
- `src/components/sensors/ntc-thermistor.ts`
- `src/components/sensors/spark-gap.ts`

#### T13: IO + memory (10 files)
- `src/components/io/button-led.ts`
- `src/components/io/clock.ts`
- `src/components/io/ground.ts`
- `src/components/io/led.ts`
- `src/components/io/probe.ts`
- `src/components/io/seven-seg-hex.ts`
- `src/components/io/seven-seg.ts`
- `src/components/memory/counter-preset.ts`
- `src/components/memory/counter.ts`
- `src/components/memory/register.ts`

#### T14: Switching + wiring (12 files)
- `src/components/switching/fuse.ts`
- `src/components/switching/relay-dt.ts`
- `src/components/switching/relay.ts`
- `src/components/switching/switch-dt.ts`
- `src/components/switching/switch.ts`
- `src/components/wiring/bus-splitter.ts`
- `src/components/wiring/decoder.ts`
- `src/components/wiring/demux.ts`
- `src/components/wiring/driver-inv.ts`
- `src/components/wiring/driver.ts`
- `src/components/wiring/mux.ts`
- `src/components/wiring/splitter.ts`

**POST-WAVE CHECK (orchestrator-mandated):** `npm run test:q` — full test suite must pass. Zero test failures. Any failures are bugs in the component migration, not deferred work.

### Wave 4: Runtime features

**State after wave: full import → save → load → simulate round-trip works.**

All tasks parallel.

#### T15: Runtime model registry
**Files to modify:** `src/core/circuit.ts` (add `models` field to `CircuitMetadata`), `src/app/spice-model-apply.ts` (rewrite to create `ModelEntry` and store in `circuit.metadata.models`)

- `circuit.metadata.models` — per-component-type runtime entries
- Import code creates `ModelEntry`:
  - `.MODEL`: copies factory + paramDefs from component's default entry, parsed values as params
  - `.SUBCKT`: derives paramDefs from subcircuit parameter declarations

**Tests:** Headless API test (create model entry, verify in registry), MCP tool test (import via tool, verify), E2E test (import dialog flow).

#### T16: Delta serialization
**Files to modify:** `src/io/dts-schema.ts`, `src/io/dts-serializer.ts`, `src/io/dts-deserializer.ts`

- Per-element saves `model` key + only user-modified params (delta from model entry defaults)
- On load: apply model entry defaults, overlay delta
- Round-trip test: save with overrides → load → same params

**Tests:** Headless API (round-trip programmatically), MCP tool (save/load via tools), E2E (save/reload in browser).

#### T17: Model switch undo
**Files to create/modify:** `src/editor/model-switch-command.ts` (new), `src/editor/property-panel.ts` (trigger ModelSwitchCommand from dropdown)

- `ModelSwitchCommand` implements `EditCommand` with `{ oldModelKey, oldParamSnapshot, newModelKey, newParamSnapshot }`
- `execute()` writes new model + params; `undo()` restores old model + params

**Tests:** Unit test (execute/undo/redo cycle preserves param values), E2E (switch model, undo, verify panel shows old params).

#### T18: Unified import dialog
**Files to modify:** `src/app/spice-import-dialog.ts` (add auto-detect, subsume subckt flow), `src/app/canvas-popup.ts` (single "Import Model" button)

- Single "Import Model..." button with auto-detect (.MODEL vs .SUBCKT)
- `.MODEL` imports: factory + paramDefs from component's default entry
- `.SUBCKT` imports: paramDefs derived from subcircuit declarations, primary/secondary assignment step
- Add R/C/L/TUNNEL to parser vocabulary (`SPICE_TYPE_TO_COMPONENT`)

**Tests:** Headless API, MCP tool, E2E.

#### T19: Model dropdown
**Files to modify:** `src/editor/property-panel.ts`, `src/app/canvas-popup.ts`

- Dropdown reads from static `modelRegistry` + `"digital"` (if available) + circuit runtime entries
- Shows all available models for the component type

**Tests:** E2E (dropdown shows expected entries after import).

**POST-WAVE CHECK (orchestrator-mandated):** Run `npm run test:q` — all pass. E2E: import `.MODEL`, save circuit, reload, verify model persists with correct params. Import `.SUBCKT`, verify paramDefs differ from base component. All three surfaces covered.

### Wave 5: Verification

#### T20: Zero-occurrence verification
Run grep for every item in the verification conditions list. Protocol:
```bash
# For each symbol:
grep -r "SYMBOL" src/ e2e/ scripts/
# For DeviceType, exclude parser:
grep -r "DeviceType" src/ e2e/ scripts/ | grep -v "model-parser.ts"
```
Zero hits required for each. Any remaining references are bugs — fix them.

#### T21: E2E test updates
Update or add E2E tests across all three surfaces for:
- Unified import dialog (headless + MCP + E2E)
- Model dropdown with runtime entries (E2E)
- Model switch in property panel (E2E)
- Delta serialization round-trip (headless + MCP + E2E)

## Files Changed

| File | Change |
|------|--------|
| `src/core/properties.ts` | Partitioned PropertyBag: `getModelParam()`, `setModelParam()`, `replaceModelParams()`, `getModelParamKeys()`, `hasModelParam()`; second internal `Map` |
| `src/core/registry.ts` | Add `AnalogFactory` type, `ParamDef`, `ModelEntry`, `modelRegistry`, `defaultModel`; remove `deviceType`, `subcircuitRefs`, old `models.mnaModels`, `getActiveModelKey`, `availableModels`, `hasAnalogModel`, `modelKeyToDomain` |
| `src/core/model-params.ts` | New — `defineModelParams()` helper |
| `src/core/analog-types.ts` | Remove `DeviceType` union (move to parser) |
| `src/core/circuit.ts` | `circuit.metadata.models` replaces `namedParameterSets`, `modelDefinitions`, `subcircuitBindings` |
| `src/solver/analog/compiler.ts` | Resolve `ModelEntry` → factory; populate model param partition; remove `_modelParams` injection; remove `ModelLibrary`/`SubcircuitModelRegistry` params; leaf factory lookup via component registry |
| `src/solver/analog/model-parser.ts` | `DeviceType` moved here as parser-internal; `VALID_DEVICE_TYPES` add R/C/L/TUNNEL; `SPICE_TYPE_TO_COMPONENT` |
| `src/solver/analog/model-library.ts` | **Delete** |
| `src/solver/analog/model-defaults.ts` | **Delete** — data absorbed into component `defineModelParams()` calls |
| `src/solver/analog/model-param-meta.ts` | **Delete** — metadata absorbed into `ParamDef` |
| `src/solver/analog/default-models.ts` | **Delete** — registration absorbed into component `modelRegistry` |
| `src/solver/analog/subcircuit-model-registry.ts` | **Delete** |
| `src/solver/analog/transistor-expansion.ts` | **Delete** — leaf factory lookup replaced by `modelRegistry` |
| `src/solver/analog/transistor-models/` | **Delete entire directory** — netlist data absorbed into gate/flipflop `modelRegistry` entries |
| `src/compile/compile.ts` | Remove `SubcircuitModelRegistry` param |
| `src/compile/partition.ts` | Replace `modelKeyToDomain()` with `model === "digital"` check |
| `src/compile/extract-connectivity.ts` | Replace `getActiveModelKey()` with `model` property + `modelRegistry` lookup |
| `src/app/canvas-popup.ts` | Single "Import Model" button; model dropdown from registry; remove old imports |
| `src/app/spice-import-dialog.ts` | Unified dialog with auto-detect |
| `src/app/spice-subckt-dialog.ts` | **Delete** — folded into unified dialog |
| `src/app/spice-model-apply.ts` | Creates `ModelEntry`, stores in `circuit.metadata.models` |
| `src/app/spice-model-library-dialog.ts` | Reworked — manages circuit runtime model entries |
| `src/app/menu-toolbar.ts` | Remove old model library dialog import |
| `src/app/test-bridge.ts` | Replace `getActiveModelKey`/`modelKeyToDomain` usage |
| `src/headless/default-facade.ts` | Remove `getTransistorModels` import; CMOS/Darlington models now on component definitions |
| `src/editor/property-panel.ts` | Partitioned display: static props + model paramDefs; model dropdown; rebuild on switch; modified indicators; remove `getParamMeta`/`availableModels` imports |
| `src/editor/model-switch-command.ts` | **New** — `ModelSwitchCommand` for undo |
| `src/io/spice-model-builder.ts` | Use `SPICE_TYPE_TO_COMPONENT` lookup |
| `src/io/dts-schema.ts` | Replace old metadata fields with `models` on `DtsDocument`; add `modelParamDeltas` on `DtsElement` |
| `src/io/dts-serializer.ts` | Serialize `circuit.metadata.models` (runtime → serialized projection); delta serialization for per-element model params; remove `SubcircuitModelRegistry` import |
| `src/io/dts-deserializer.ts` | Deserialize `circuit.metadata.models` (rehydrate from component registry); apply per-element deltas; crash on old-format fields; remove `ModelLibrary`/`SubcircuitModelRegistry` imports |
| `src/test-fixtures/model-fixtures.ts` | **New** — shared test fixtures |
| `circuits/debug/*.dig` | Delete our own .dig files carrying `simulationModel` |
| `src/components/semiconductors/*.ts` (13 files) | `modelRegistry` + `defineModelParams()`; factory reads `getModelParam()` directly |
| `src/components/passives/*.ts` (10 files) | `modelRegistry` + `defineModelParams()` |
| `src/components/gates/*.ts` (7 files) | Retain `models.digital`; `modelRegistry` with `"cmos"` netlist entry; absorb CMOS netlist data |
| `src/components/flipflops/*.ts` (7 files) | Same pattern; `d.ts` absorbs CMOS D-flipflop netlist |
| `src/components/active/*.ts` (14 files) | `modelRegistry` with `"behavioral"` entry |
| `src/components/sources/*.ts` (4 files) | `modelRegistry` with `"behavioral"` entry |
| `src/components/sensors/*.ts` (3 files) | `modelRegistry` with `"behavioral"` entry |
| `src/components/io/*.ts` (7 files) | `modelRegistry` with `"behavioral"` entry |
| `src/components/memory/*.ts` (3 files) | `modelRegistry` with `"behavioral"` entry |
| `src/components/switching/*.ts` (5 files) | `modelRegistry` with `"behavioral"` entry |
| `src/components/wiring/*.ts` (7 files) | `modelRegistry` with `"behavioral"` entry |
| `e2e/gui/spice-import-flows.spec.ts` | Test unified dialog + model dropdown |
| `e2e/gui/component-sweep.spec.ts` | Update for `model` property (was `simulationModel`) |
| `e2e/gui/spice-model-panel.spec.ts` | Update for new model panel layout |
