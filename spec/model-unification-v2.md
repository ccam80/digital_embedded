# Model System Unification v2

## Status of v1

The v1 spec (`spec/model-unification.md`) established named MNA models and a unified compile pipeline. Implementation is complete with these review fixes applied:

**Fixed:**
- Compiler routing: `resolveComponentRoute()` discriminated union replaces old mode name strings (`"logical"`, `"analog-pins"`, `"analog-internals"`)
- `resolveModelAssignments()` delegates to `getActiveModelKey()`, throws on invalid keys with `invalid-simulation-model` diagnostic
- Per-net loading overrides wired into bridge synthesis (were accepted but never read)
- 6 missing `defaultModel: "behavioral"` on components
- Dead types, aliases, stale comments, `engineType` in Zod schema removed
- All test files updated to use new model keys

**Outstanding — all addressed as action items in this spec:**

### Weak test assertions (fix: replace with specific value assertions)

| File | Count | Issue |
|------|-------|-------|
| `digital-pin-loading-mcp.test.ts` | 8 | `not.toBeNull`, `toBeGreaterThan(0)` — assert exact adapter counts and parameter values |
| `spice-model-overrides-mcp.test.ts` | 2 | `not.toBeNull` pair — assert compiled structure |
| `behavioral-combinational.test.ts` | 3 | `toBeDefined()` — assert factory is callable or model structure |
| `behavioral-flipflop.test.ts` | 1 | `toBeDefined()` — same |
| `behavioral-sequential.test.ts` | 1 | `toBeDefined()` — same |
| `pin-loading-menu.test.ts` | 1 | `not.toBeNull()` — assert partition content |
| `analog-compiler.test.ts` | 2 | `toBeDefined()` guards before real assertions — remove redundant guards |
| `diag-rc-step.test.ts` | 2 | `not.toBeNull` + `toBeGreaterThan(0)` — assert exact element count |
| SPICE test files | 6 | `toBeDefined()` — assert content/structure |

### Missing three-surface test coverage (fix: write the tests)

- E2E test for pin loading menu affecting simulation behavior (v1 Wave 6)
- MCP test for `circuit_describe` reflecting named models (v1 Wave 5)
- MCP surface test for SPICE import features: parsed `.MODEL` → patch → compile round-trip (v1 Waves 10-12)

### Implementation gaps (fix: implement per original spec)

- `applySpiceImportResult()` must accept `circuit` parameter and persist to `circuit.metadata.namedParameterSets` (in addition to existing `_spiceModelOverrides` on the element — both coexist; library-level + per-instance)
- `applySpiceSubcktImportResult()` must accept `circuit` parameter and persist to `circuit.metadata.modelDefinitions`
- SPICE import context menu: move wiring from `menu-toolbar.ts` to `canvas-popup.ts` per v1 spec

### Code health (fix: delete dead code, fix callers)

| File | Issue | Action |
|------|-------|--------|
| `src/editor/wire-merge.ts` | Re-export shim | Delete file, update all consumers to import from `@/core/wire-utils` |
| `src/editor/pin-voltage-access.ts` | `@deprecated` re-export | Delete file, update all consumers to import from `../core/pin-voltage-access.js` |
| `src/runtime/analog-scope-panel.ts:746` | `AnalogScopePanel` deprecated alias | Delete alias, update all consumers to use `ScopePanel` |
| `src/components/wiring/splitter.ts:103` | `parseSplittingPattern` | Delete function, fix any callers |
| `src/editor/context-menu.ts:96` | `show()` overload | Delete overload, update callers to use `showItems()` |
| `src/fixtures/__tests__/shape-audit.test.ts:150` | `it.skip` | Remove skip — test must run |
| `src/fixtures/__tests__/fixture-audit.test.ts:225` | `it.skip` | Remove skip — test must run |
| `src/solver/analog/model-parser.ts:14-17` | Re-export of DeviceType | Delete re-export, update consumers to import from `core/analog-types.ts` |

## Motivation for v2

The v1 implementation preserved a fundamental architectural split that the v1 spec intended to eliminate. Hand-written factories and subcircuit expansions are treated as two different kinds of model with different compiler paths, different node allocation, and different power rail handling.

The v1 spec said (line 2): "Whether the stamps were hand-written, expanded from a subcircuit, or parsed from SPICE text is an authoring concern — the runtime is the same."

What actually shipped:
1. The compiler has an `expand` route distinct from `stamp`, with dedicated `expandTransistorModel()`.
2. "CMOS" is a privileged model type — hardcoded subcircuit definitions with implicit VDD/GND, distinct from user-imported `.SUBCKT`.
3. All expansions share a single VDD rail at a circuit-wide voltage. Mixed-voltage circuits (3.3V driving 5V) are impossible.
4. Power pins are invisible — VDD/GND are compiler-injected, not user-wired.

Additionally, the VDD component (`src/components/io/vdd.ts`) is digital-only — it outputs all-ones bit vectors. There is no analog VDD rail component. The analog "VDD" is a hidden voltage source created by `makeVddSource()` in the compiler, invisible to the user.

## End State

After v2, the system looks like this:

### MnaModel is a stamp factory, always

```typescript
interface MnaModel {
  factory: (pinNodes, internalNodeIds, branchIdx, props, getTime) => AnalogElementCore;
  getInternalNodeCount?: (props: PropertyBag) => number;
  branchCount?: number;
  deviceType?: DeviceType;
  defaultParams?: Record<string, number>;
}
```

`factory` is **required**. `subcircuitModel` is gone. Every MNA model produces stamps. How the factory was authored (hand-written, compiled from a subcircuit, generated from parsed SPICE) is invisible to the compiler.

Subcircuit-backed factories return a single composite `AnalogElementCore` that internally aggregates multiple sub-element stamps. The compiler treats it like any other single element — no array handling, no special-case iteration.

`branchCount` replaces `requiresBranchRow`. Default is 0 (no branches). Single-branch models use 1. Subcircuit factories compute the total from their sub-elements. Pass A allocates that many sequential branch indices; the factory receives the base index and owns `branchCount` sequential indices from there.

### MnaSubcircuitNetlist — the compiled subcircuit format

Subcircuit models are stored as compiled netlists, not `Circuit` objects. This is the internal representation regardless of authoring origin (code-defined, SPICE import, user-drawn).

```typescript
interface MnaSubcircuitNetlist {
  /** Port labels in order — maps to outer component pins by label match */
  ports: string[];

  /** Exposed parameters with defaults — user can override at instance level.
      SPICE .PARAM equivalent. */
  params?: Record<string, number>;

  /** Sub-elements: topology + model references + per-element parameters */
  elements: SubcircuitElement[];

  /** Number of internal nets (nodes that aren't ports) */
  internalNetCount: number;

  /** Net connectivity: netlist[elementIndex][pinIndex] → net index.
      Net indices 0..ports.length-1 are external ports.
      Net indices ports.length.. are internal nets. */
  netlist: number[][];
}

interface SubcircuitElement {
  /** Component type (NMOS, PMOS, Resistor, Diode, etc.) */
  typeId: string;

  /** Named .MODEL reference — resolved from ModelLibrary at compile time.
      e.g., "NMOS_HC", "PMOS2", "1N4148". */
  modelRef?: string;

  /** Element-level parameter overrides (W, L from netlist line).
      String values reference subcircuit params by name
      (e.g., W: "W_P" means use the subcircuit's W_P parameter). */
  params?: Record<string, number | string>;
}
```

This is **not** a `Circuit` object with Wire positions and PropertyBags. It's a compiled netlist — just connectivity + model references + parameters. No pixel coordinates, no rendering artifacts.

### Model library — circuit-level named parameter sets

Models are a **circuit-level shared resource**, not owned by any subcircuit. Multiple subcircuits can reference the same model name. Swapping a model definition affects all subcircuits that reference it. This matches SPICE semantics.

Already partially exists as:
- `circuit.metadata.namedParameterSets: Record<string, { deviceType, params }>` — storage
- `ModelLibrary` — runtime lookup with `add()`, `get()`, `getDefault()`

```
Circuit
├── metadata.namedParameterSets
│   "NMOS_HC"  → { deviceType: "NMOS", params: { VTO: 0.7, KP: 110e-6, ... } }
│   "PMOS_HC"  → { deviceType: "PMOS", params: { VTO: -0.7, KP: 50e-6, ... } }
│   "1N4148"   → { deviceType: "D", params: { IS: 2.52e-9, N: 1.752, ... } }
│
├── metadata.modelDefinitions
│   "74HC00"   → MnaSubcircuitNetlist { ports, elements with modelRefs, ... }
│
├── metadata.subcircuitBindings
│   "And:74hc" → "74HC00"   // circuit-local: component type + model key → definition name
│
└── elements[]
    └── And gate instance
        ├── simulationModel: "74hc"
        └── (subcircuitRefs on ComponentDefinition: { "74hc": "CmosAnd2" })
```

### Import workflows

| User action | What happens |
|-------------|-------------|
| Import `.MODEL` file | Parsed → entries added to `circuit.metadata.namedParameterSets` |
| Import `.SUBCKT` with inline `.MODEL` | Inline models → `namedParameterSets`. Topology compiled → `MnaSubcircuitNetlist` → `modelDefinitions` |
| Import `.SUBCKT` with external refs | Topology → `MnaSubcircuitNetlist` → `modelDefinitions`. Unresolved refs → **hard error at compile time** |
| Delete a named model | Remove from `namedParameterSets`. Subcircuits referencing it → hard error on next compile |
| Swap technology | Replace entries in `namedParameterSets`. Same names, different values. All subcircuits pick up changes on recompile |

### Parameter resolution at compile time

For each sub-element inside a subcircuit expansion:

```
1. Device defaults     — built-in defaults for device type (NMOS_DEFAULTS, etc.)
2. Named model         — look up modelRef in circuit.metadata.namedParameterSets
                         If modelRef exists but model NOT found → hard error diagnostic
                         (code: "unresolved-model-ref", severity: "error")
3. Element params      — W, L etc. from the SubcircuitElement.params
4. Subcircuit params   — resolve any string references to subcircuit-level .PARAM values,
                         with outer instance overrides applied first
5. Instance overrides  — user tweaks via property panel on the outer component
```

Each layer merges over the previous. The result is a fully resolved `Record<string, number>` passed to the element's factory.

String references in `SubcircuitElement.params` that don't match any declared subcircuit param are a hard error (diagnostic code: `"unresolved-model-ref"`).

### Subcircuit models resolved into factories post-partition

A field on `ComponentDefinition` holds static references:

```typescript
interface ComponentDefinition {
  // ... existing fields ...
  subcircuitRefs?: Record<string, string>;  // model key → subcircuit definition name
}
```

Additionally, circuit-local bindings (from user imports via model library dialog) are stored in:

```typescript
interface CircuitMetadata {
  // ... existing fields ...
  subcircuitBindings?: Record<string, string>;  // "ComponentType:modelKey" → definition name
}
```

After partitioning but before Pass A, the compiler resolves subcircuit-backed models:

1. For each `PartitionedComponent` whose active model key appears in `subcircuitRefs` or `subcircuitBindings`:
2. Look up the `MnaSubcircuitNetlist` in `modelDefinitions`
3. For each sub-element, resolve the full parameter chain (device defaults → named model → element params → subcircuit params → instance overrides) using the `ModelLibrary`
4. Wrap the expansion + parameter merge in a composite `AnalogElementCore` factory closure
5. Replace `pc.model` with the resolved `MnaModel`

If the subcircuit name is not found in `modelDefinitions`, emit diagnostic `"unresolved-model-ref"` and set `pc.model = null` (routes to `skip`).

```typescript
function resolveSubcircuitModels(
  partition: SolverPartition,
  modelDefinitions: Record<string, MnaSubcircuitNetlist>,
  modelLibrary: ModelLibrary,
  subcircuitBindings: Record<string, string>,
  diagnostics: Diagnostic[],
): void {
  for (const pc of partition.components) {
    const modelKey = getActiveModelKey(pc.element, pc.definition);
    const defName = pc.definition.subcircuitRefs?.[modelKey]
      ?? subcircuitBindings[`${pc.definition.typeName}:${modelKey}`];
    if (!defName) continue;

    const netlist = modelDefinitions[defName];
    if (!netlist) {
      diagnostics.push({ code: 'unresolved-model-ref', severity: 'error', ... });
      pc.model = null;
      continue;
    }

    pc.model = compileSubcircuitToMnaModel(netlist, modelLibrary, pc);
  }
}
```

The main compiler loop only ever sees `{ kind: 'stamp' | 'bridge' | 'skip' }`.

### Subcircuit netlists are atomic — no topology-parameter factoring

A 74HC D-flipflop and a CD4000 D-flipflop might have identical circuit topology with different transistor model references. These are stored as **two separate `MnaSubcircuitNetlist` objects**, not as a shared template + parameter binding. This is intentional:

- `MnaSubcircuitNetlist` is small (~200 bytes for a gate, ~1KB for an opamp). 12 opamp variants with similar internals is ~12KB. Not a concern.
- Factoring topology from parameters creates an abstraction layer (templates, binding resolution, conditional logic for topology variants) with no practical benefit at this scale.
- SPICE process design kits ship hundreds of structurally similar `.SUBCKT` definitions without factoring. The subcircuit IS the unit of reuse.
- The real orthogonality is between subcircuit topology (which references models by name) and the model library (which provides the parameters). A `MnaSubcircuitNetlist` says "use NMOS_HC here" — the model library defines what NMOS_HC means. Swapping parameters means changing the library entry, not editing every subcircuit.

### Built-in CMOS models migrate to MnaSubcircuitNetlist

`cmos-gates.ts` and `cmos-flipflop.ts` currently produce `Circuit` objects. They migrate to producing `MnaSubcircuitNetlist` directly — topology + `modelRef` on each transistor element. Built-in `.MODEL` definitions for default CMOS parameters are registered in `namedParameterSets` alongside user-imported models.

This means built-in models are editable — a user can modify `NMOS_DEFAULT` parameters and all built-in CMOS gates pick up the change. Same mechanism as user-imported models.

### `PinDeclaration.kind` field

Add to `src/core/pin.ts`:

```typescript
interface PinDeclaration {
  // ... existing fields ...
  /** Pin kind. "signal" participates in digital schemas.
      "power" is excluded from digital inputSchema/outputSchema. */
  kind: "signal" | "power";
}
```

Required on all declarations. All existing declarations must add `kind: "signal"` explicitly. Digital `inputSchema`/`outputSchema` only count signal pins. The compiler's digital path ignores power pins. The MNA path treats all pins identically — power pins are just more nodes.

Where the filter is applied: `src/solver/digital/compiler.ts`, in the pin-to-slot matching logic. Filter predicate: `pinDecl.kind === "signal"`. Wires connected to power pins in digital mode are silently ignored (no diagnostic — the pin simply doesn't exist in the digital schema).

### Model-dependent pin visibility

Components with subcircuit models gain power pins when those models are active.

`getPins()` already reads properties and returns dynamic pin arrays (gates do this for `inputCount`). Extend: when the active `simulationModel` resolves to an MNA model backed by a subcircuit, append VDD and GND pin declarations with `kind: "power"`.

Power pin positions are per-component, hardcoded in each component's `getPins()`:

```typescript
// In gate getPins() — conceptual
const basePins = buildStandardPinDeclarations(inputCount, ...);
const activeModel = props.get("simulationModel") as string | undefined;
if (activeModel && def.subcircuitRefs?.[activeModel]) {
  basePins.push(
    { label: "VDD", direction: "input", kind: "power", position: { x: vddX, y: vddY } },
    { label: "GND", direction: "input", kind: "power", position: { x: gndX, y: gndY } },
  );
}
return basePins;
```

Each of the 9 affected components (8 gates + D flip-flop) specifies its own VDD/GND coordinates based on its body geometry. When the user switches back to digital mode, power pins disappear. Any wires connected to them become dangling (existing dangling-wire handling applies).

### Factory unification — subcircuit pre-compilation

The `compileSubcircuitToMnaModel` function (called by `resolveSubcircuitModels` post-partition):

```typescript
function compileSubcircuitToMnaModel(
  netlist: MnaSubcircuitNetlist,
  modelLibrary: ModelLibrary,
  pc: PartitionedComponent,
): MnaModel {
  // Resolve all sub-element parameters upfront (5-layer resolution)
  const resolvedParams = resolveAllElementParams(netlist, modelLibrary, pc);

  // Compute total branch count across all sub-elements
  const totalBranches = computeTotalBranchCount(netlist, resolvedParams);

  return {
    factory(pinNodes, internalNodeIds, branchIdx, props, getTime) {
      // Returns a single composite AnalogElementCore that internally
      // aggregates stamps from all sub-elements.
      // Maps subcircuit ports to pinNodes by label (including VDD/GND — regular pins).
      // Internal nodes from internalNodeIds.
      // Sub-element branch indices allocated sequentially from branchIdx.
      return makeCompositeElement(netlist, resolvedParams, pinNodes, internalNodeIds, branchIdx, getTime);
    },
    getInternalNodeCount(_props) {
      return netlist.internalNetCount;
    },
    branchCount: totalBranches,
  };
}
```

The existing `expandTransistorModel()` logic moves inside `makeCompositeElement`. The function itself can be refactored or kept as an internal implementation detail — the important thing is the compiler loop never sees `subcircuitModel`.

After this change, `resolveComponentRoute` simplifies to:

```typescript
type ComponentRoute =
  | { kind: 'stamp'; model: MnaModel }
  | { kind: 'bridge' }
  | { kind: 'skip' };
```

The `expand` kind is gone.

### Component declaration changes

Pattern E components (gates with subcircuit models) update their declarations:

```typescript
// BEFORE (v1)
models: {
  digital: { executeFn: executeAnd, ... },
  mnaModels: {
    behavioral: { factory: makeAndAnalogFactory(0) },
    cmos: { subcircuitModel: "CmosAnd2" },
  },
},

// AFTER (v2)
models: {
  digital: { executeFn: executeAnd, ... },
  mnaModels: {
    behavioral: { factory: makeAndAnalogFactory(0) },
    // cmos model populated at compile time from subcircuitRefs
  },
},
subcircuitRefs: { cmos: "CmosAnd2" },
```

### Eliminate implicit VDD/GND

**Remove from `expandTransistorModel()` / the new factory wrapper:**
- `vddNodeId` parameter — VDD is now a regular pin, mapped through `pinNodes`
- `gndNodeId` parameter — GND is now a regular pin, mapped through `pinNodes`
- Special-case label matching for `"VDD"` and `"GND"` in the expansion code — these become regular label matches against the component's pin layout

**Remove from compiler:**
- `vddNodeId` / `vddBranchIdx` lazy allocation (`compiler.ts:602, 1042-1044`)
- `makeVddSource()` injection (`compiler.ts:111-136, 1373-1383`)
- Circuit-wide VDD voltage from logic family for expansion purposes

**The VDD voltage source** is now the user's responsibility: wire the power pin to a VDD rail component or a voltage source at the desired voltage. This is how every other analog component works.

### Rename `TransistorModelRegistry` → `SubcircuitModelRegistry`

The registry stores subcircuit definitions for expansion. It is not transistor-specific — it stores CMOS gates, Darlington pairs, user-imported `.SUBCKT` definitions, or any composite model.

Rename everywhere:
- `src/solver/analog/transistor-model-registry.ts` → `subcircuit-model-registry.ts`
- All imports and references
- `registerAllCmosGateModels()` → `registerBuiltinSubcircuitModels()`

### No privileged model types

The key name `"cmos"` has no special meaning to the compiler — it's just one possible key in `mnaModels`, like `"behavioral"`, `"ideal"`, or `"74HC"`. Built-in CMOS gate models are pre-registered subcircuit definitions. User-imported `.SUBCKT` definitions go through the same path. The compiler doesn't know the difference.

## Serialization

### New format

DTS stores `MnaSubcircuitNetlist` directly:

```typescript
// In DtsDocument
modelDefinitions?: Record<string, {
  ports: string[];
  params?: Record<string, number>;
  elements: Array<{
    typeId: string;
    modelRef?: string;
    params?: Record<string, number | string>;
  }>;
  internalNetCount: number;
  netlist: number[][];
}>;

namedParameterSets?: Record<string, {
  deviceType: string;
  params: Record<string, number>;
}>;

subcircuitBindings?: Record<string, string>;
```

No `DtsCircuit`, no wire coordinates, no rendering data. Just topology + model refs + params.

### Load path

```
File on disk (DTS)
  → modelDefinitions → MnaSubcircuitNetlist objects → SubcircuitModelRegistry
  → namedParameterSets → ModelLibrary
  → subcircuitBindings → CircuitMetadata
```

### Save path

```
SubcircuitModelRegistry → serialize each MnaSubcircuitNetlist → modelDefinitions
ModelLibrary → namedParameterSets
CircuitMetadata.subcircuitBindings → subcircuitBindings
```

### DiagnosticCode additions

Add to `src/compile/types.ts` DiagnosticCode union:

```typescript
| 'unresolved-model-ref'
```

Emitted when a subcircuit references a model name not found in `namedParameterSets`, or when a component's `subcircuitRefs`/`subcircuitBindings` points to a definition not found in `modelDefinitions`.

## Model library dialog

The existing dialog (Wave 11.3, `src/app/spice-model-library-dialog.ts`) shows two tabs: `.MODEL` parameter sets and `.SUBCKT` definitions. It needs these changes:

**Named parameter sets tab:**
- List all entries in `circuit.metadata.namedParameterSets`
- Add: paste `.MODEL` text or upload file → parse → add to library
- Edit: select entry → show parameter table → edit values in place
- Remove: delete entry (hard error on next compile if any subcircuit references it)
- Import multiple: paste a file with multiple `.MODEL` definitions → all added

**Subcircuit definitions tab:**
- List all entries in `circuit.metadata.modelDefinitions` (now `MnaSubcircuitNetlist` format)
- Add: paste `.SUBCKT` text or upload file → parse → compile to `MnaSubcircuitNetlist` → add. Inline `.MODEL` definitions extracted and added to `namedParameterSets` automatically.
- Show: port count, element count, referenced model names, whether all refs resolve
- Remove: delete entry (hard error on next compile if any component's `subcircuitRefs` references it)
- Unresolved refs highlighted: if a subcircuit references `NMOS2` and it's not in `namedParameterSets`, show warning in the list

**Assign to component type:**
- From the subcircuit tab, user can assign a subcircuit to a component type as a new model key
- This writes to `circuit.metadata.subcircuitBindings` (circuit-local, survives save/load)
- The model selector dropdown on instances of that component type then includes the new key
- On recompile, the compiler merges `ComponentDefinition.subcircuitRefs` (static, from registration) with `metadata.subcircuitBindings` (dynamic, from user assignment)

## What does NOT change

- `mnaModels: Record<string, MnaModel>` structure
- `getActiveModelKey()` + `modelKeyToDomain()` resolution chain
- `resolveComponentRoute()` — simplified but same role
- `digitalPinLoading` and per-net overrides — orthogonal, unchanged
- `.SUBCKT` parser and import UI — unchanged, feeds into SubcircuitModelRegistry
- `.MODEL` parameter sets — still stored as `_spiceModelOverrides` on instances (per-instance overrides), `namedParameterSets` on circuit metadata (library-level). Both coexist: library provides defaults, instance overrides customize individual components.

## Files affected

| Area | Files | Nature |
|------|-------|--------|
| Pin system | `src/core/pin.ts` | Add required `kind` field |
| All component declarations | Every file with `PinDeclaration` | Add `kind: "signal"` to all existing pin declarations |
| Gate components | 8 gate files + `src/components/flipflops/d.ts` | `getPins()` adds power pins with per-component positions |
| Gate shared | `src/components/gates/gate-shared.ts` | Pin builder helpers |
| Compiler | `src/solver/analog/compiler.ts` | Remove `expand` route, VDD injection; add `resolveSubcircuitModels` post-partition step |
| Expansion | `src/solver/analog/transistor-expansion.ts` | Refactor into composite factory, remove VDD/GND params |
| Registry | `src/solver/analog/transistor-model-registry.ts` → `subcircuit-model-registry.ts` | Rename |
| CMOS models | `src/solver/analog/transistor-models/cmos-gates.ts`, `cmos-flipflop.ts` | Migrate from Circuit objects to `MnaSubcircuitNetlist` |
| Digital compiler | `src/solver/digital/compiler.ts` | Filter `kind === "signal"` in pin-to-slot matching |
| Types | `src/compile/types.ts` | Add `unresolved-model-ref` to DiagnosticCode |
| Registry types | `src/core/registry.ts` | `MnaModel.factory` required, `subcircuitModel` deleted, `branchCount` replaces `requiresBranchRow`, `subcircuitRefs` on ComponentDefinition |
| Circuit metadata | `src/core/circuit.ts` | Add `subcircuitBindings` to CircuitMetadata |
| Serialization | `src/io/dts-schema.ts`, `src/io/dts-serializer.ts`, `src/io/dts-deserializer.ts`, `src/io/load.ts` | `modelDefinitions` stores `MnaSubcircuitNetlist`, add `subcircuitBindings`, add `namedParameterSets` to JSON schema |
| SPICE apply | `src/app/spice-model-apply.ts` | Add `circuit` parameter to both functions |
| Model library dialog | `src/app/spice-model-library-dialog.ts` | Subcircuit tab shows `MnaSubcircuitNetlist`, assign-to-component writes `subcircuitBindings` |
| Tests | `transistor-expansion.test.ts`, `cmos-gates.test.ts`, `darlington.test.ts`, + new | Update for explicit power pins, factory path, composite elements |

## Testing requirements

Per CLAUDE.md three-surface rule:

**Headless:** Compile CMOS gate with explicit VDD pin wired to voltage source → verify stamps use wired voltage. Compile two gates at different voltages → verify different output levels. Subcircuit model compiles through factory path. Digital mode ignores power pins (schema pin count unchanged). Unresolved `modelRef` emits `unresolved-model-ref` diagnostic.

**MCP:** `circuit_build` with gate + voltage source on VDD → `circuit_compile` → `circuit_step` → verify output. `circuit_describe` shows power pins when subcircuit model active.

**E2E:** Select subcircuit model on gate → power pins appear. Switch to digital → power pins disappear. Wire VDD to voltage source → simulate → correct output.
