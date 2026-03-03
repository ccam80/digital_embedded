# Shared Architectural Decisions

These decisions are binding for all implementation agents across all phases. Read this before writing any code.

This document complements `spec/plan.md` (what to build) and `spec/author_instructions.md` (how to write TypeScript). This document defines **cross-cutting contracts** that prevent inconsistency between phases.

---

## Decision 1: CircuitElement Has No Simulation Logic

**Flat standalone functions are the simulation path. `CircuitElement` does not have an `execute()` method.**

`CircuitElement` is the editor-facing object. It handles identity, pin declarations, properties, rendering, and serialization. It has a `draw(ctx: RenderContext)` method. It does **not** have `execute()`, `readInputs()`, `writeOutputs()`, or any simulation method.

Simulation logic lives in standalone flat functions:

```typescript
// src/components/gates/and.ts

// This is the simulation logic. Not a method — a standalone function.
export function executeAnd(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);
  let result = ~0;
  for (let i = 0; i < inputCount; i++) {
    result &= state[inputStart + i];
  }
  state[outputIdx] = result;
}
```

The compiled engine calls these functions via a function table indexed by numeric type ID. The inner loop is:

```typescript
for (let i = 0; i < componentCount; i++) {
  executeFns[typeIds[i]](i, state, layout);
}
```

No object allocation. No method dispatch. Monomorphic per call site in the function table.

### Implications

- Phase 5 (components): each file exports a `CircuitElement` class AND a standalone `executeFoo` function. The function is the source of truth for logic — not a wrapper around a method.
- Phase 3 (engine): builds a function table from registered `executeFn` entries. Never instantiates `CircuitElement` objects during simulation.
- Phase 2 (editor): works with `CircuitElement` objects for rendering and property editing. Never calls simulation functions.

---

## Decision 2: Signal Ownership and Access Protocol

**The engine owns the signal `Uint32Array`. All consumers read through accessor methods.**

Signal state is stored in a flat `Uint32Array` indexed by net ID. The engine owns this array. No other code holds a direct reference to it.

Two accessors exist on the engine interface:

| Method | Returns | Allocates? | Use case |
|---|---|---|---|
| `getSignalRaw(netId): number` | Raw bit value | No | Wire rendering, hot-path reads (~thousands/frame) |
| `getSignalValue(netId): BitVector` | Rich object with `.toHex()`, `.width`, etc. | Yes | Property panels, tooltips, data tables (~few/frame) |

### Rules

- **Phase 2 (renderer):** Use `getSignalRaw()` for wire coloring. Never hold a reference to the underlying array.
- **Phase 3 (engine):** Owns the array. Implements both accessors. In main-thread mode, `getSignalRaw()` is `return state[netId]`. In Worker mode, it's `return Atomics.load(sharedView, netId)`.
- **Phase 5 (component flat functions):** Receive the `state` array as a parameter. Read and write by index. Do not store references to it.
- **Phase 7 (runtime tools):** Use `getSignalValue()` for formatted display in data tables, hex editors, value dialogs.

### Worker mode vs main-thread mode

- **Main thread (fallback):** Engine runs on the main thread. `state` is a plain `Uint32Array`. UI reads it directly through the accessor.
- **Web Worker (preferred):** Engine runs in a Worker. `state` is backed by `SharedArrayBuffer`. UI reads through `Atomics.load()` via the same accessor. The accessor hides which mode is active.

Worker mode requires `Cross-Origin-Isolation` HTTP headers. If unavailable, the engine falls back to main-thread mode automatically. The rendering code is identical in both cases — it always calls `getSignalRaw()`.

---

## Decision 3: Visual Model and Executable Model Are Separate

**`Circuit` is the visual model. `CompiledModel` is the executable model. The compiler transforms one into the other.**

### Visual model (`src/core/`)

```
Circuit
  ├── elements: CircuitElement[]   — positioned on grid, with properties
  ├── wires: Wire[]                — visual segments with pixel coordinates
  └── metadata: CircuitMetadata    — name, description, test data
```

This is what the `.dig` parser produces, what the editor manipulates, and what gets serialized. It contains **zero simulation state** — no signal values, no net IDs, no execution order.

### Executable model (`src/engine/`)

```
CompiledModel
  ├── state: Uint32Array           — all signal values, flat
  ├── typeIds: Uint8Array          — type ID per component slot
  ├── executeFns: Function[]       — function table indexed by type ID
  ├── sortOrder: Uint32Array       — topological evaluation order
  ├── wiring: ComponentWiring[]    — input/output net IDs per component
  └── (no positions, no wire coordinates, no visual data)
```

This is what the engine runs. It is produced by the compiler (Phase 3, task 3.2.1) from a `Circuit`.

### The compiler bridges them

```
Circuit (visual) → Compiler → CompiledModel (executable)
```

The compiler walks the visual circuit, traces wire connections to build nets, assigns net IDs, topologically sorts combinational logic, and produces the flat arrays the engine needs.

### How the renderer shows live values

After compilation, the renderer needs to color wires by signal value. The compiler produces a mapping:

```typescript
wireToNetId: Map<Wire, number>
```

The renderer uses this to call `engine.getSignalRaw(netId)` for each wire during drawing. This mapping lives in the editor-engine binding layer (Phase 6, task 6.1.2), not on `Wire` or `Net`.

### Rules

- `Wire` has no `netId` property. `Net` in the visual model (if it exists) is just "these pins are connected" — no signal value.
- The `CompiledModel` has no positions or visual data.
- The binding layer (Phase 6) holds the cross-references between visual objects and net IDs.

---

## Decision 4: One Registry, One Registration Shape

**Every component type registers once, providing everything all consumers need.**

```typescript
interface ComponentDefinition {
  name: string;                          // "And" — matches .dig elementName
  typeId: number;                        // auto-assigned at registration time
  factory: (props: PropertyBag) => CircuitElement;
  executeFn: (index: number, state: Uint32Array, layout: ComponentLayout) => void;
  pinLayout: PinDeclaration[];           // default pins
  propertyDefs: PropertyDefinition[];    // for the property panel
  attributeMap: AttributeMapping[];      // .dig XML → PropertyBag converters
  category: ComponentCategory;           // for palette grouping
}
```

### Type ID assignment

Type IDs are **auto-assigned** by the registry at registration time (incrementing counter). They are never serialized — they exist only at runtime for function-table dispatch. This avoids maintaining a central ID list.

### Who uses what

| Consumer | Fields used |
|---|---|
| Phase 4 (parser) | `name`, `factory`, `attributeMap` |
| Phase 3 (compiler) | `name`, `typeId`, `executeFn`, `pinLayout` |
| Phase 2 (editor) | `name`, `factory`, `pinLayout`, `propertyDefs`, `category` |

### Registration

Each Phase 5 component file calls `registry.register(...)` with all fields populated. This happens at module load time (top-level side effect or explicit init call).

---

## Decision 5: PropertyBag Is the Universal Property Format

**Components only see `PropertyBag`. The `.dig` attribute mapping converts XML strings into `PropertyBag` entries. No other conversion path exists.**

### The pipeline

```
.dig XML attributes → AttributeMapping[].convert() → PropertyBag → factory(props) → CircuitElement
```

An `AttributeMapping` is:

```typescript
interface AttributeMapping {
  xmlName: string;                          // "Bits" — key in the .dig file
  propertyKey: string;                      // "bitWidth" — key in our PropertyBag
  convert: (xmlValue: string) => PropertyValue;  // "8" → 8
}
```

### Native JSON format

JSON save/load skips attribute mapping entirely. It serializes `PropertyBag` directly:

```
JSON file ↔ PropertyBag ↔ factory(props) ↔ CircuitElement
```

### Rules

- Components never see raw XML. They receive a `PropertyBag` from their factory.
- The parser never needs to know what properties a component has. It reads the registry's `attributeMap` and applies converters mechanically.
- The property panel reads `propertyDefs` from the registry to know what fields to show and their types.

---

## Decision 6: Pins Are Visual-Only

**`Pin` has no simulation state. The compiler assigns net IDs. The engine sees only integer indices.**

### Visual layer (`Pin` interface)

```typescript
interface Pin {
  direction: PinDirection;   // INPUT, OUTPUT, BIDIRECTIONAL
  position: Point;           // relative to component origin
  label: string;             // "A", "B", "Q"
  bitWidth: number;          // 1 for single-bit, N for bus
  isNegated: boolean;        // draw inversion bubble
  isClock: boolean;          // draw clock triangle
}
```

No `netId`. No `signalValue`. No simulation data whatsoever.

### Engine layer (integer wiring)

The compiler produces wiring tables that map component slots to net IDs:

```typescript
interface ComponentWiring {
  componentIndex: number;
  inputNets: number[];    // net IDs for each input pin, in pin declaration order
  outputNets: number[];   // net IDs for each output pin, in pin declaration order
}
```

The flat execute function reads `state[inputNets[0]]`, `state[inputNets[1]]`, etc. It doesn't know pin names, positions, or labels.

### Rules

- Phase 1 (task 1.2.2): `Pin` is visual/declarative only. No simulation state.
- Phase 3 (compiler): walks pin declarations + wire topology → assigns net IDs → produces integer wiring tables.
- Phase 5 (components): declare pins via `PinDeclaration[]`. The flat execute function operates on net indices, never `Pin` objects.
- Phase 2 (renderer): draws pins using `Pin.position`, `Pin.isNegated`, etc. Colors them using the `wireToNetId` mapping and `getSignalRaw()`.
