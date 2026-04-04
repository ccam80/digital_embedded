# Circuit-Scoped Subcircuit Resolution + Import Subcircuit + .dts-First MCP

## Context

Subcircuit definitions are registered into a shared mutable global `ComponentRegistry` that persists for the process lifetime. Loading circuit A's subcircuits pollutes the registry for circuit B. The registry is used as a **factory lookup table** — `registry.get(type).factory(props)` creates elements. But the flattener/compiler never touches the registry for subcircuits — it duck-types `el.internalCircuit`. So the registry is just a middleman for element creation.

**Goal**: Circuit-scoped subcircuit storage as the single source of truth. Global registry stays clean (built-ins only). A unified `resolveComponentDef()` function replaces direct `registry.get()` calls at all element-creation sites. Plus: "Import Subcircuit from File" across all 4 surfaces and .dts-first MCP loading.

---

## Wave 1: Core Infrastructure

### 1a. Add `subcircuits` to `CircuitMetadata`

**File:** `src/core/circuit.ts` (~line 179, after `models`)

```typescript
subcircuits?: Map<string, SubcircuitDefinition>;
```

Import `SubcircuitDefinition` type. Mirrors existing `models` pattern.

### 1b. Extract `buildSubcircuitComponentDef()` from `registerSubcircuit()`

**File:** `src/components/subcircuit/subcircuit.ts:508-579`

Extract the `ComponentDefinition` construction (lines 513-566) into a new **pure function**:

```typescript
export function buildSubcircuitComponentDef(
  name: string, definition: SubcircuitDefinition
): ComponentDefinition { ... }
```

`registerSubcircuit()` becomes a thin wrapper: `registry.registerOrUpdate(buildSubcircuitComponentDef(name, def))`.

### 1c. Create `resolveComponentDef()`

**New file:** `src/core/resolve-component.ts`

Single chokepoint for all element creation:

```typescript
export function resolveComponentDef(
  typeName: string,
  circuit: Circuit | null,
  registry: ComponentRegistry,
): ComponentDefinition | undefined {
  if (circuit?.metadata.subcircuits) {
    // Handle both "Foo" and "Subcircuit:Foo" lookups
    const lookupName = typeName.startsWith('Subcircuit:')
      ? typeName.slice(11) : typeName;
    const subDef = circuit.metadata.subcircuits.get(lookupName);
    if (subDef) return buildSubcircuitComponentDef(lookupName, subDef);
  }
  return registry.get(typeName);
}
```

---

## Wave 2: Wire Up All Element-Creation Call Sites (Category A)

Six call sites where `registry.get()` is used for factory/element creation. ALL change to `resolveComponentDef()`.

| # | File:Line | Change |
|---|-----------|--------|
| A1 | `src/io/dts-deserializer.ts:219` | `createElement()` — add `circuit` param, use `resolveComponentDef(savedEl.type, circuit, registry)` |
| A2 | `src/headless/builder.ts:178` | `addComponent()` — already has `circuit` param, use `resolveComponentDef(typeName, circuit, this.registry)` |
| A3 | `src/io/dig-loader.ts:147` | `createElementFromDig()` — add `circuit` param, thread from `loadDigCircuit()` |
| A4 | `src/io/ctz-format.ts:344` | CTZ import — use `resolveComponentDef(digiTsType, circuit, registry)` |
| A5 | `src/io/resolve-generics.ts:300` | `handleNonCodeElement()` — add `circuit` param |
| A6 | `src/io/resolve-generics.ts:331` | `addComponent()` in generics — add `circuit` param |

### DTS Deserializer Ordering Change (critical)

**File:** `src/io/dts-deserializer.ts:278-300`

Current order: deserialize main circuit (line 290), then subcircuits (line 292-297).
**Must reverse**: parse subcircuit definitions first -> create `SubcircuitDefinition`s -> store on circuit metadata -> THEN deserialize main circuit elements (which can now resolve subcircuit types).

```
1. Parse + validate DtsDocument
2. Rehydrate models
3. Create Circuit with metadata (no elements yet)
4. For each subcircuitDefinition:
   - deserializeDtsCircuit() -> Circuit
   - createLiveDefinition() -> SubcircuitDefinition
   - Store in circuit.metadata.subcircuits
5. Deserialize main circuit elements (createElement can now resolve subcircuit types)
6. Deserialize main circuit wires
```

The `deserializeDtsCircuit()` function at line 148 currently creates the Circuit and its elements in one pass. Needs to be split: create-metadata-only pass, then elements pass. OR: keep the function as-is but have the **outer** `deserializeDts()` attach subcircuits to the metadata between steps.

### .dig Loader Changes

**File:** `src/io/subcircuit-loader.ts:99-228`

`loadWithSubcircuits()` currently registers subcircuits into the global registry. Change to:
1. Add a `subcircuitDefs: Map<string, SubcircuitDefinition>` accumulator
2. `resolveAndRegister()` -> `resolveAndCollect()`: creates `SubcircuitDefinition`, stores in accumulator (no registry mutation)
3. After recursion completes, set `circuit.metadata.subcircuits = subcircuitDefs`
4. Pass subcircuit defs through to `loadDigCircuit()` so `createElementFromDig()` can resolve them

**File:** `src/io/dig-loader.ts:76-178`

`loadDigCircuit()` and `createElementFromDig()` gain a `subcircuitDefs` parameter (or a `circuit` parameter) for resolution.

---

## Wave 3: Serialization Round-Trip

### 3a. DTS Serializer — emit from circuit metadata

**File:** `src/io/dts-serializer.ts:267-278`

`serializeCircuit()` checks `circuit.metadata.subcircuits` and emits `subcircuitDefinitions`:

```typescript
if (circuit.metadata.subcircuits?.size) {
  doc.subcircuitDefinitions = {};
  for (const [name, subDef] of circuit.metadata.subcircuits) {
    doc.subcircuitDefinitions[name] = circuitToDtsCircuit(subDef.circuit);
  }
}
```

`serializeWithSubcircuits()` (line 289) can be deprecated or become a thin wrapper.

### 3b. Return type of `deserializeDts()`

The returned `{ circuit, subcircuits }` tuple is vestigial — subcircuits now live on `circuit.metadata.subcircuits`. Change return to just `Circuit` (or keep the tuple for one release cycle as a read-through view).

**Consumers to update:**
- `scripts/mcp/circuit-tools.ts:55` — remove subcircuit registration block entirely
- `src/io/postmessage-adapter.ts:639` — already destructures `{ circuit }`, no change
- `src/app/file-io-controller.ts:158` — already destructures `{ circuit }`, no change
- Tests

---

## Wave 4: MCP Surface

### 4a. Fix `circuit_load` — .dts-first with .dig fallback

**File:** `scripts/mcp/circuit-tools.ts:34-84`

Format detection by content inspection (matches UI pattern):
```
content.trimStart().startsWith('{') -> deserializeDts() [.dts JSON]
else -> loadWithSubcircuits() [.dig XML]
```

Update description and schema to say ".dts or .dig". Remove the subcircuit registration block (lines 55-68) — subcircuits are now on `circuit.metadata.subcircuits`.

### 4b. Add `circuit_import_subcircuit` tool

**File:** `scripts/mcp/circuit-tools.ts` (new tool)

```
Input: { handle, path, name? }
- Reads file, detects format
- Parses into Circuit
- Creates SubcircuitDefinition via createLiveDefinition()
- Stores in circuit.metadata.subcircuits
- Returns pins and usage instructions for circuit_patch add ops
```

### 4c. Update `circuit_patch` on-demand loading

**File:** `scripts/mcp/circuit-tools.ts:371-388`

Change from `registerSubcircuit(registry, ...)` to storing in `circuit.metadata.subcircuits`. Extend to handle `.dts` files alongside `.dig` (format detection on content).

---

## Wave 5: Headless + PostMessage Surfaces

### 5a. Headless facade method

**File:** `src/headless/default-facade.ts`

Add:
```typescript
async importSubcircuit(
  circuit: Circuit,
  name: string,
  content: string,
  resolver?: FileResolver,
): Promise<SubcircuitDefinition>
```

Parses content (format detection), creates `SubcircuitDefinition`, stores on `circuit.metadata.subcircuits`.

**File:** `src/headless/types.ts` — add to `SimulatorFacade` interface.

### 5b. PostMessage handler

**File:** `src/io/postmessage-adapter.ts`

New message: `sim-import-subcircuit { name, data, format? }`
Response: `sim-subcircuit-imported { name, pins }` or `sim-error`

In GUI mode, the hook enters placement mode after import.

---

## Wave 6: UI Surface

### 6a. "Import Subcircuit..." menu item

**File:** `src/app/menu-toolbar.ts` or `src/app/file-io-controller.ts`

Under Insert menu:
1. File picker (accept: `.dts,.dig`)
2. Parse file -> create `SubcircuitDefinition` -> store on circuit metadata
3. Enter `placement.start(definition)` for immediate placement
4. Refresh palette to show new subcircuit type

### 6b. `insertAsSubcircuit()` — store on circuit metadata

**File:** `src/editor/insert-subcircuit.ts:323-325`

Change from `registerSubcircuit(registry, ...)` to `circuit.metadata.subcircuits.set(name, def)`.

### 6c. Palette — merge circuit-scoped subcircuits

**File:** `src/editor/palette.ts`

Palette reads from `registry.getByCategory(SUBCIRCUIT)` + `circuit.metadata.subcircuits`. The latter takes priority.

---

## Wave 7: Cleanup

- Remove `_subcircuitCache` module-level map from `src/io/subcircuit-loader.ts:39-68`
- Remove `clearSubcircuitCache()`, `invalidateSubcircuit()`, `subcircuitCacheSize()`
- Mark `registerSubcircuit()` as editor-palette-only (or remove if palette reads from circuit metadata)
- Remove `Subcircuit:` alias registration from global registry

---

## Files Modified (complete list)

| File | Wave | Change |
|------|------|--------|
| `src/core/circuit.ts` | 1a | Add `subcircuits` to `CircuitMetadata` |
| `src/components/subcircuit/subcircuit.ts` | 1b | Extract `buildSubcircuitComponentDef()` |
| `src/core/resolve-component.ts` | 1c | **NEW** — `resolveComponentDef()` |
| `src/io/dts-deserializer.ts` | 2,3 | Reverse ordering; use `resolveComponentDef()`; store on metadata |
| `src/headless/builder.ts` | 2 | `addComponent()` uses `resolveComponentDef()` |
| `src/io/dig-loader.ts` | 2 | Thread circuit/subcircuit context |
| `src/io/ctz-format.ts` | 2 | Use `resolveComponentDef()` |
| `src/io/resolve-generics.ts` | 2 | Use `resolveComponentDef()` (2 sites) |
| `src/io/subcircuit-loader.ts` | 2,7 | Accumulate into circuit metadata; remove global cache |
| `src/io/dts-serializer.ts` | 3 | Emit from `circuit.metadata.subcircuits` |
| `scripts/mcp/circuit-tools.ts` | 4 | .dts-first loading; import tool; cleanup |
| `src/headless/default-facade.ts` | 5 | Add `importSubcircuit()` |
| `src/headless/types.ts` | 5 | Add to interface |
| `src/io/postmessage-adapter.ts` | 5 | Add `sim-import-subcircuit` |
| `src/app/menu-toolbar.ts` | 6 | Import menu item + placement |
| `src/editor/insert-subcircuit.ts` | 6 | Store on circuit metadata |
| `src/editor/palette.ts` | 6 | Merge circuit-scoped subcircuits |

## Call sites NOT changed (confirmed safe)

All `registry.get()` calls in compiler, coordinator, worker, netlist, equivalence, serializer, palette metadata reads, analysis, and synthesis — these operate on already-instantiated elements or built-in types only, never subcircuit factory creation.

## Verification

1. **Unit**: Import .dts/.dig subcircuit via facade, verify `circuit.metadata.subcircuits` populated, compile and step, verify round-trip serialization preserves subcircuits
2. **MCP**: `circuit_load` with .dts file, `circuit_import_subcircuit`, then `circuit_compile` + `circuit_step`
3. **E2E**: `sim-import-subcircuit` postMessage, verify placement mode, verify palette refresh
4. **Regression**: All existing tests pass — no global registry pollution means test isolation improves
