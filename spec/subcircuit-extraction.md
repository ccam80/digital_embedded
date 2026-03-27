# Subcircuit Extraction — Full Spec

## Problem Statement

The codebase has solid subcircuit infrastructure (loading, rendering, flattening, registry) but no way for a user to **create** a subcircuit from the editor. The existing extraction code (`insert-subcircuit.ts`) is digital-only: it assumes `In`/`Out` interface elements, directed signal flow, and integer bit-widths. This doesn't work for analog or mixed-mode circuits where boundary crossings are undirected voltage/current nodes.

This spec defines a domain-agnostic subcircuit extraction system that works uniformly for digital, analog, and mixed-mode selections.

---

## Architecture

### Core Concept: `Port` — the Domain-Agnostic Interface Element

The fundamental problem is that `In` and `Out` are digital concepts. A resistor terminal isn't an "input" or "output" — it's a **port** where voltage and current are both present and bidirectional.

**Solution**: Introduce a `Port` component type that serves as the universal subcircuit interface element. `Port` is domain-neutral — the compilation pipeline infers domain from context, exactly as it already does for `ConnectivityGroup` boundary detection.

```
Port
  Properties:
    label: string        — user-visible name (required, unique within subcircuit)
    bitWidth: number     — signal width (default 1; >1 for digital buses)
    face: Face           — which chip face this pin appears on (left/right/top/bottom)
    sortOrder: number    — position within face (auto-assigned, user-adjustable)

  Pins:
    "port" — single bidirectional pin (PinDirection.BIDIRECTIONAL)

  Models:
    NONE — Port is neutral infrastructure (like Ground, Tunnel).
    It carries no simulation model. The compilation pipeline infers
    domain from what's connected to it, not from the Port itself.

  Rendering:
    Small diamond or circle at the circuit edge (distinct from In/Out arrows)
```

**Why not reuse `In`/`Out`?** Three reasons:
1. Direction is wrong for analog — a resistor connected to the boundary is neither input nor output
2. `In` has digital-specific behavior (drives a value) that makes no sense for analog nodes
3. The compilation pipeline already handles bidirectional signals at `ConnectivityGroup` boundaries — `Port` aligns with that existing mechanism

**Why no model entries?** Port is pure neutral infrastructure — the same category as `Ground` and `Tunnel`. It doesn't compute anything; it just declares "this internal node is the same as that external node." The domain of the signal flowing through it is determined entirely by what's connected to it, not by the Port itself.

Giving Port separate `digital` and `analog` models would be worse:
- The model assignment logic would have to pick one, adding a decision point that doesn't need to exist
- At a mixed-mode boundary, neither model is correct — the Port straddles both domains
- It perpetuates the false idea that the interface element cares about domain

To achieve this, `Port` is added to the `INFRASTRUCTURE_TYPES` set in `extract-connectivity.ts` (alongside Wire, Tunnel, Ground, VDD, etc.). This assigns `modelKey: "neutral"` via the infrastructure path — the same code path that already handles Ground and Tunnel. The partitioner routes infrastructure components based on their connectivity group's domain: analog group → analog partition, digital group → digital partition, mixed group → both partitions (producing a `BridgeDescriptor`). This existing mechanism handles Port with zero new code in the partitioner.

**Backward compatibility**: Existing `.dig` files with `In`/`Out` continue to work. `deriveInterfacePins()` recognizes `In`, `Out`, `Clock`, AND `Port`. When loading legacy subcircuits, nothing changes. When extracting new subcircuits, `Port` elements are created.

### Compilation Integration: Node Merge

Port has one behavior in every domain: **node merge at flatten time**. The internal node and the external node become the same node. The Port element is eliminated before either compiler sees the circuit.

This is the same operation expressed differently in each domain's vocabulary:
- **Digital**: two nets become one net — all pins see the same signal value
- **Analog**: two MNA nodes share one row/column — same voltage, current conservation

But the flattener doesn't need to know which domain it's in. It performs the same mechanical steps regardless:
1. Find the Port element by label in the internal circuit
2. Create a bridge wire from the parent's pin position to the Port's pin position
3. Include the Port in the flat circuit (it's a zero-cost identity node)

**Performance**: Zero runtime cost per timestep — the Port doesn't exist in the simulation engine. Flatten cost is O(1) per Port (label lookup + wire redirect). No MNA matrix entries, no extra digital net indirection, no Newton-Raphson impact.

**Digital flattening** (`flatten.ts`): `findInterfaceElement()` is extended to match `typeId === "Port"` in addition to `In`/`Out`. A Port with `bitWidth > 1` behaves like a bidirectional bus.

**Partition-based compilation** (`partition.ts`): Port gets `modelKey: "neutral"` via `INFRASTRUCTURE_TYPES` in `extract-connectivity.ts`. The partitioner routes infrastructure components based on their connectivity group's domain — the same path Ground and Tunnel already take. At cross-domain boundary groups, the existing `BridgeDescriptor` mechanism handles the conversion automatically.

**Analog compilation** (`compiler.ts`): After flattening, the analog compiler never sees a Port. The bridge wire created during flatten connects the parent net directly to the internal component's pin. The MNA node assignment operates on the flattened circuit — no special Port handling needed.

---

## Extraction Workflow

### Step 1: Boundary Analysis (refactored)

Replace the current direction-based `analyzeBoundary()` with a domain-agnostic version.

**Current** (broken for analog):
```
For each boundary wire:
  selectedPin.direction === OUTPUT → subcircuit output
  selectedPin.direction === INPUT  → subcircuit input
```

**New**: The boundary analysis doesn't determine domain at all — that's the compilation pipeline's job. It just identifies which wires cross the boundary and derives a label and bit width for each.

```
For each boundary wire:
  Identify the pin on the selected element that the wire touches.
  Record:
    label: derive from pin label + element label (deduplicated)
    bitWidth: from pin declaration
    position: wire endpoint in world coordinates
```

Every boundary crossing produces a `Port` — always bidirectional, always domain-agnostic. The compilation pipeline will later determine whether the signal flowing through it is digital, analog, or a cross-domain bridge point.

```typescript
interface BoundaryPort {
  wire: Wire;
  label: string;
  bitWidth: number;
  position: Point;
}
```

This replaces the current `BoundaryWireInfo` interface (which carries direction and a pin label derived from `PinDirection`) and the `BoundaryAnalysis` type. Both are removed — `analyzeBoundary()` returns `{ boundaryPorts: BoundaryPort[]; internalWires: Wire[] }` instead. The existing test file `src/editor/__tests__/insert-subcircuit.test.ts` is updated to use the new types.

### Step 2: Subcircuit Circuit Construction

Create a new `Circuit` containing:
1. **All selected elements** (deep-copied, not by reference — the originals stay in the parent for undo)
2. **All internal wires** (both endpoints on selected elements)
3. **One `Port` element per boundary crossing**, positioned at the boundary wire's intersection point

For each `BoundaryPort`:
- Create a `Port` component instance with the derived label and bitWidth
- Position it at the selected-element-side endpoint of the boundary wire (the point where the internal circuit meets the boundary, not the external endpoint)
- Wire the `Port`'s pin to the internal element's pin that the boundary wire was connected to
- Assign a face based on the port's relative position to the selection centroid:
  - Left of centroid → `left` face
  - Right of centroid → `right` face
  - Above centroid → `top` face
  - Below centroid → `bottom` face

### Step 3: Registration

Register the extracted circuit as a `SubcircuitDefinition`:
- `deriveInterfacePins()` reads the `Port` elements (and any `In`/`Out` if present) to build the chip's pin layout
- `registerSubcircuit()` adds it to the registry under `ComponentCategory.SUBCIRCUIT`
- The palette updates to show the new subcircuit

### Step 4: Instance Placement

In the parent circuit:
1. Remove the selected elements and internal wires
2. Create a `SubcircuitElement` instance (`src/components/subcircuit/subcircuit.ts:88`) positioned at the selection's centroid:
   - `typeId`: `"Subcircuit:{name}"` (e.g. `"Subcircuit:MyAdder"`)
   - `instanceId`: generated via existing `generateInstanceId()` convention
   - `position`: centroid of selected elements (grid-snapped)
   - `rotation`: 0, `mirror`: false
   - `props`: `PropertyBag` with `label: ""`, `shapeType: "DEFAULT"`
   - `definition`: the `SubcircuitDefinition` created in Step 3 (passed to constructor)
3. Reconnect boundary wires: for each wire that previously connected to a selected element's pin, create a new wire from the external endpoint to the corresponding pin position on the `SubcircuitElement` (pin positions are computed by `buildPositionedPinDeclarations()` based on the chip's dimensions and pin layout)

This is an atomic `EditCommand` for undo/redo. Undo restores the original elements and wires; redo replaces them with the subcircuit instance.

---

## UI Design

### Context Menu Entry

When the user right-clicks with **2+ elements selected** (and not in locked mode), add a menu item after the existing "Delete" entry:

```
  Copy          Ctrl+C
  Delete        Del
  ─────────────────────
  Make Subcircuit…
```

The item is disabled when:
- Only 1 element is selected (not meaningful)
- Simulation is running (circuit structure is frozen)
- Selection contains no wires connecting to unselected elements (no interface — would produce a subcircuit with zero ports)

### Name Dialog

Clicking "Make Subcircuit…" opens a modal dialog using the existing `createModal()` pattern:

```
┌─ Create Subcircuit ──────────────────────────────┐
│                                                  │
│  Name:  [____________________________]           │
│                                                  │
│  Ports:                                          │
│    Label          Width   Face                   │
│    [A___________] [1___]  [left▾]                │
│    [B___________] [1___]  [left▾]                │
│    [out_________] [1___]  [right▾]               │
│    [GND_________] [1___]  [bottom▾]              │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ Preview: chip outline with pin stubs     │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│              [Cancel]  [Create]                   │
│                                                  │
└──────────────────────────────────────────────────┘
```

**Fields**:
- **Name** (required): Text input, auto-focused. Validated: non-empty, no duplicates in registry.
- **Ports** (editable table): Each boundary crossing produces a row. Columns:
  - **Label** (text input): Defaults to the connected pin's label, suffixed with a number if duplicate (e.g., `out`, `out_2`). User can rename before creation.
  - **Width** (number input): Bit width, defaulted from the connected pin. Editable.
  - **Face** (dropdown): Auto-assigned from position relative to selection centroid. User can override.
  - Validation: labels must be non-empty and unique within the table. Duplicates highlighted in red.
- **Preview**: Small canvas rendering of the subcircuit chip shape. Implementation: create an offscreen `<canvas>` element, wrap its `CanvasRenderingContext2D` in a `CanvasRenderer` (from `src/editor/canvas-renderer.ts`), compute chip dimensions via `countPinsByFace()`, then call `drawDefaultShape(ctx, name, pinDeclarations, width, height, 0)` from `shape-renderer.ts`. The `PinDeclaration[]` is built from the dialog's live port table state. Updates live as name, labels, and face assignments change.

**Buttons**:
- **Cancel**: Close dialog, no changes.
- **Create**: Execute extraction, close dialog.

### Post-Creation

After creation:
1. The subcircuit instance appears on the canvas where the selection was
2. The palette's SUBCIRCUIT category shows the new entry
3. A status bar message confirms: `Created subcircuit "MyAdder" (4 ports)`
4. The user can double-click the instance to drill down into it (existing navigation works)
5. The user can drag more instances from the palette

### Property Panel for Subcircuit Instances

When a subcircuit instance is selected, the property panel shows:

| Property | Type | Editable | Notes |
|----------|------|----------|-------|
| Label | STRING | yes | Instance label (like any component) |
| Shape | ENUM | yes | DEFAULT / SIMPLE / DIL / CUSTOM / LAYOUT / MINIMIZED — changes chip rendering style (maps to `ShapeMode` in `shape-renderer.ts`) |

### Property Panel for Port Elements (inside subcircuit)

When editing inside a subcircuit (via drill-down), selecting a `Port` element shows:

| Property | Type | Editable | Notes |
|----------|------|----------|-------|
| Label | STRING | yes | The pin name on the chip exterior |
| Bit Width | BIT_WIDTH | yes | 1–32 (only meaningful for digital; analog is always 1) |
| Face | ENUM | yes | left / right / top / bottom — controls pin placement on chip |
| Sort Order | INT | yes | Position within face (0 = topmost/leftmost) |

Changing face or sort order immediately updates the parent subcircuit's chip rendering.

---

## Persistence

### Browser Storage

User-created subcircuits are persisted in IndexedDB so they survive page refresh. Follow the `folder-store.ts` pattern:

```typescript
// src/io/subcircuit-store.ts

const DB_NAME = "digital-js-subcircuits";
const STORE_NAME = "subcircuits";

interface StoredSubcircuit {
  name: string;
  xml: string;         // serialized .dig XML
  created: number;     // unix-ms timestamp
  modified: number;    // unix-ms timestamp
}

// API:
storeSubcircuit(name: string, xml: string): Promise<void>  // upsert: creates or updates, sets modified timestamp
loadAllSubcircuits(): Promise<StoredSubcircuit[]>
deleteSubcircuit(name: string): Promise<void>
```

Unlike `folder-store.ts` (single-slot), this store holds **multiple named entries** — one per user-created subcircuit.

### Lifecycle

- **On app init**: Load all stored subcircuits, register each in the registry, populate palette
- **On create**: Serialize the extracted circuit to .dig XML, store in IndexedDB, register in registry
- **On edit** (inside subcircuit drill-down): On every `UndoRedoStack.push()` command within the subcircuit's circuit, re-serialize and update IndexedDB via `storeSubcircuit()` (upsert — updates `modified` timestamp). Hook into the undo stack's existing change listener pattern
- **On delete**: Remove from IndexedDB, unregister from registry, remove from palette

### Export/Import

- **Export**: "Save Subcircuit" in the context menu of a subcircuit palette entry downloads the `.dig` XML file. Standard browser download pattern (Blob + anchor click).
- **Import**: "Import Subcircuit" in the File menu or palette header loads a `.dig` file, registers it, and stores it in IndexedDB. Uses the existing `loadWithSubcircuits()` for recursive resolution.
- **Circuit save**: When saving the main circuit, subcircuit definitions are embedded in the `.dig` XML (same as Java Digital's approach — the subcircuit's XML is nested or referenced by name).

---

## Port Component Implementation

### Registration

```typescript
// src/components/io/port.ts

export const PortDefinition: ComponentDefinition = {
  name: "Port",
  category: ComponentCategory.IO,
  propertyDefs: [
    { key: "label",     type: PropertyType.STRING,    default: "" },
    { key: "bitWidth",  type: PropertyType.BIT_WIDTH, default: 1 },
    { key: "face",      type: PropertyType.ENUM,      default: "left",
      options: ["left", "right", "top", "bottom"] },
    { key: "sortOrder", type: PropertyType.INT,        default: 0 },
  ],
  pinLayout: [
    { direction: PinDirection.BIDIRECTIONAL, label: "port",
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false },
  ],
  models: {},  // No models — neutral infrastructure. Domain inferred from connectivity.
};
```

### .dig XML Serialization

Port serializes to `.dig` XML using the standard `dig-serializer.ts` element serialization path. The element name is `"Port"` and properties map to XML attributes via the standard `attributeMap` convention:

```xml
<visualElement>
  <elementName>Port</elementName>
  <elementAttributes>
    <entry><string>Label</string><string>A</string></entry>
    <entry><string>Bits</string><int>1</int></entry>
    <entry><string>pinFace</string><string>left</string></entry>
    <entry><string>pinOrder</string><int>0</int></entry>
  </elementAttributes>
  <pos x="100" y="60"/>
</visualElement>
```

The `attributeMap` for Port maps internal keys to XML names: `label` → `Label`, `bitWidth` → `Bits`, `face` → `pinFace`, `sortOrder` → `pinOrder`. This follows the same convention as In/Out/Clock components.

### Pin Derivation Update

```typescript
// In pin-derivation.ts, extend deriveInterfacePins():

for (const element of circuit.elements) {
  if (element.typeId === "In" || element.typeId === "Clock") {
    // ... existing logic (unchanged)
  } else if (element.typeId === "Out") {
    // ... existing logic (unchanged)
  } else if (element.typeId === "Port") {
    const label = element.getProperties().getOrDefault<string>("label", "");
    const bitWidth = element.getProperties().getOrDefault<number>("bitWidth", 1);
    const face = element.getProperties().getOrDefault<string>("face", "left") as Face;
    const sortPos = element.getProperties().getOrDefault<number>("sortOrder", 0);

    facedPins.push({
      face,
      label: label || `port${facedPins.length}`,
      bitWidth,
      direction: PinDirection.BIDIRECTIONAL,
      sortPos,
    });
  }
}
```

**Note**: Unlike `In`/`Out` which derive face from element rotation (via `inputFace()`/`outputFace()` in `pin-derivation.ts`), Port reads face from a stored property. This is deliberate — Port's face assignment comes from the extraction dialog (based on position relative to centroid) and is user-editable, not tied to a rendering convention.

### Flattener Update

In `flatten.ts`, extend the existing private `findInterfaceElement()` (line 413):

```typescript
function findInterfaceElement(
  flatCircuit: Circuit,
  label: string,
  direction: PinDirection,
): CircuitElement | undefined {
  // First try Port (domain-agnostic, preferred for new subcircuits)
  for (const el of flatCircuit.elements) {
    if (el.typeId === "Port") {
      const elLabel = el.getAttribute("label");
      if (typeof elLabel === "string" && elLabel === label) return el;
    }
  }

  // Fall back to In/Out (legacy subcircuits)
  // BIDIRECTIONAL pins (from Port-derived interface) don't map to In/Out,
  // so skip the fallback for those — they should have matched Port above.
  if (direction === PinDirection.BIDIRECTIONAL) return undefined;

  const targetTypeId = direction === PinDirection.INPUT ? "In" : "Out";
  for (const el of flatCircuit.elements) {
    if (el.typeId !== targetTypeId) continue;
    const elLabel = el.getAttribute("label");
    if (typeof elLabel === "string" && elLabel === label) return el;
  }
  return undefined;
}
```

### Same-Domain Analog Subcircuits

The flattener currently fails for same-domain analog subcircuits because it searches for `In`/`Out` elements and finds none. With `Port`, the same flatten path works for both domains:

1. The flattener finds `Port` elements by label (unified `findInterfaceElement()`)
2. Bridge wires connect the parent net to the Port's pin position
3. The Port is included in the flattened circuit as an identity node
4. The analog compiler assigns one MNA node ID to the entire connected group — the Port, the bridge wire, and the internal components all share one node

This is a wire splice — which is exactly what an analog subcircuit interface should be. No special analog flatten path is needed. The same mechanical steps (find interface element, create bridge wire, include in flat circuit) produce the correct result in every domain.

---

## Rendering

### Port Element Shape

Inside the subcircuit (drill-down view), `Port` renders as:

```
  ◇──  (diamond + stub wire)
  label
```

Distinct from `In` (triangle pointing right) and `Out` (triangle pointing left). The diamond communicates "bidirectional/domain-agnostic".

### Chip Pin Stubs

On the `SubcircuitElement` exterior, pins derived from `Port` elements render identically to existing pins. The shape renderer already handles left/right/top/bottom faces. No change needed.

For analog-domain ports, the pin stub could optionally render as a filled dot (like an analog terminal) rather than a logic-style stub. This is a cosmetic enhancement, not a functional requirement.

---

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `src/components/io/port.ts` | `Port` component definition, element class, registration |
| `src/io/subcircuit-store.ts` | IndexedDB persistence for user-created subcircuits |
| `src/app/subcircuit-dialog.ts` | Create Subcircuit modal dialog |

### Modified Files

| File | Change |
|------|--------|
| `src/components/register-all.ts` | Register `PortDefinition` |
| `src/components/subcircuit/pin-derivation.ts` | Recognize `Port` in `deriveInterfacePins()` |
| `src/solver/digital/flatten.ts` | Extend `findInterfaceElement()` to match `Port` |
| `src/editor/insert-subcircuit.ts` | Refactor to domain-agnostic boundary analysis: replace `BoundaryWireInfo`/`BoundaryAnalysis` with `BoundaryPort`, create `Port` elements instead of metadata-encoded boundary pins. Remove dead `pinLayout.length > 0 ? pinLayout : boundaryPins` fallback in `insertAsSubcircuit()` (line 261) |
| `src/app/app-init.ts` | Load stored subcircuits after `createDefaultRegistry()` in init sequence. Wire subcircuit dialog result to `insertAsSubcircuit()` |
| `src/app/menu-toolbar.ts` | Add "Make Subcircuit…" context menu item in the element right-click handler (after the "Delete" item at line 218), gated on `selection.getSelectedElements().size >= 2 && !ctx.isSimActive()` |
| `src/editor/palette.ts` | Add `refreshCategories()` method that re-reads the registry's `SUBCIRCUIT` category and rebuilds the tree. Called after subcircuit create/delete |
| `src/editor/property-panel.ts` | Add shape mode property for subcircuit instances |
| `src/compile/extract-connectivity.ts` | Add `'Port'` to `INFRASTRUCTURE_TYPES` set (line 21) |
| `src/solver/digital/compiler.ts` | Add `"Port"` to `LABELED_TYPES` set (line 685) — root of all digital label resolution |
| `src/solver/analog/compiler.ts` | Add `"Port"` to `labelTypes` set (lines 621, 1744) — root of all analog label resolution |
| `src/headless/test-runner.ts` | Add `'Port'` to `inputCount` typeId check (line 76) |
| `src/headless/default-facade.ts` | Add `'Port'` to `inputCount` typeId check (line 209) |
| `src/io/postmessage-adapter.ts` | Add `'Port'` to tutorial test validation typeId check (lines 428–429) |
| `src/app/canvas-interaction.ts` | Add `'Port'` to click-to-toggle typeId check (lines 550, 571) |
| `src/testing/comparison.ts` | Add `'Port'` to signal inventory for exhaustive equivalence comparison (lines 98, 106) |
| `src/testing/fixture-generator.ts` | Add `'Port'` to input/output name extraction (lines 36, 57) |

### Test Files

| File | Purpose |
|------|---------|
| `src/components/io/__tests__/port.test.ts` | Port element unit tests |
| `src/editor/__tests__/insert-subcircuit.test.ts` | Update existing tests + add mixed-mode cases |
| `src/solver/digital/__tests__/flatten-port.test.ts` | Flatten with Port interface elements |
| `src/headless/__tests__/port-mcp.test.ts` | MCP tool surface tests for Port-based subcircuits |
| `e2e/gui/subcircuit-creation.spec.ts` | Full UI workflow E2E test |

### Test Assertions

**`port.test.ts`** (headless unit):
- `PortDefinition.pinLayout` has exactly 1 pin with `direction: BIDIRECTIONAL` and `label: "port"`
- Port element created with `bitWidth: 4` returns pin with `bitWidth === 4`
- Port serializes to .dig XML and deserializes back with all properties preserved (`label`, `bitWidth`, `face`, `sortOrder`)
- `deriveInterfacePins()` on a circuit containing a Port element returns a `PinDeclaration` with `direction: BIDIRECTIONAL` and the Port's label
- Port with `models: {}` resolves to `modelKey: "neutral"` via `resolveModelAssignments()`

**`insert-subcircuit.test.ts`** (headless unit):
- `analyzeBoundary()` returns `BoundaryPort[]` (not `BoundaryWireInfo[]`) with no `direction` field
- Label deduplication: two boundary wires touching pins both labeled `out` produce ports labeled `out` and `out_2`
- Undo of `insertAsSubcircuit()` restores all original elements and wires to the circuit
- Selection with zero boundary crossings (internal island) returns empty `boundaryPorts`
- Extracted subcircuit contains `Port` elements (not `In`/`Out`) at boundary positions

**`flatten-port.test.ts`** (headless unit):
- `findInterfaceElement()` matches a Port element by label when `direction` is `BIDIRECTIONAL`
- `findInterfaceElement()` falls back to `In`/`Out` for `INPUT`/`OUTPUT` direction (legacy)
- `findInterfaceElement()` returns `undefined` for `BIDIRECTIONAL` when no Port matches (does not incorrectly match `Out`)
- Flattening a subcircuit with Port interface elements produces bridge wires connecting parent nets to internal pins
- Port with `bitWidth: 8` flattens correctly (bus-width preserved across bridge)

**`port-mcp.test.ts`** (MCP tool surface):
- `circuit_build` with a Port component succeeds and `circuit_netlist` shows the Port in the component list
- `circuit_build` a subcircuit using Port interfaces, `circuit_compile` succeeds
- `circuit_test` against a Port-based subcircuit resolves test vector columns to Port labels
- `setInput()`/`readOutput()` via the facade resolve Port labels (not just In/Out)

**`subcircuit-creation.spec.ts`** (E2E browser):
- Right-click with 2+ elements selected shows "Make Subcircuit…" menu item
- "Make Subcircuit…" is disabled when simulation is running
- Dialog opens with auto-populated port table matching boundary wire count
- Changing a port's face in the dialog updates the chip preview
- Clicking "Create" replaces selection with a subcircuit instance on the canvas

---

## Implementation Order

1. **Port component** — definition, element class, registration, INFRASTRUCTURE_TYPES, unit tests
2. **Pin derivation + flattener updates** — recognize Port, verify with existing subcircuit tests
3. **Label resolution unification** — extend executor, runner, compiled-circuit, editor-binding to recognize Port
4. **Boundary analysis refactor** — domain-agnostic BoundaryPort, Port element creation in extracted circuit
5. **Instance placement** — create SubcircuitElement in parent, reconnect boundary wires, EditCommand
6. **Context menu + dialog** — UI wiring, name prompt, preview
7. **Persistence** — subcircuit-store.ts, load on init, update on undo-stack push
8. **Palette integration** — show user subcircuits, drag to place, delete, refreshCategories()
9. **MCP + E2E tests** — MCP tool surface tests, full UI workflow across digital, analog, and mixed-mode circuits

Steps 1–5 are the engine work (can be tested headlessly). Steps 6–8 are the UI work. Step 9 validates the full stack across all three surfaces.

---

## Resolved Design Decisions

1. **Port rendering**: Diamond shape (◇). Communicates bidirectional/domain-agnostic correctly.

2. **Nested extraction**: Yes — infinite nesting supported. Users can drill into a subcircuit and extract a sub-subcircuit. The flattener already handles recursive nesting. The context menu item appears in drill-down view exactly as in the top-level view.

3. **Edit propagation**: Shared definition — all instances update when the subcircuit internals change. This matches Java Digital's behavior and is the natural consequence of registry-based definitions. The definition is the single source of truth; instances are references to it.

4. **Port label derivation**: Default to the pin label of the connected element (e.g., if a boundary wire touches an AND gate's `out` pin, the port is labeled `out`). If duplicates arise, suffix with a number (`out`, `out_2`, `out_3`). Labels are **editable in the dialog** before creation — the ports list becomes an editable table, not read-only.

---

## Label Resolution: Extend Compiler and Consumers to Recognize Port

An audit of all three surfaces (headless, postMessage, UI) reveals that label resolution is **centralized in the compilers**. The runtime signal I/O methods (`setInput()`, `readOutput()`, `readAllSignals()`) in `runner.ts`, `default-facade.ts`, `editor-binding.ts`, and `postmessage-adapter.ts` all resolve labels via `coordinator.compiled.labelSignalMap` with **zero typeId checks** — they are already Port-compatible.

The actual typeId hardcoding is concentrated in 5 locations:

### Changes Required

| File | Line(s) | Current typeIds | Change |
|------|---------|----------------|--------|
| `src/solver/digital/compiler.ts` | 685 | `LABELED_TYPES = ["In", "Out", "Probe", "Measurement", "Clock"]` | Add `"Port"` — this is the root of all digital label resolution |
| `src/solver/analog/compiler.ts` | 621, 1744 | `labelTypes = ["In", "Out", "Probe", "in", "out", "probe"]` | Add `"Port"` — root of all analog label resolution |
| `src/headless/test-runner.ts` | 76 | `el.typeId === 'In' \|\| el.typeId === 'Clock'` | Add `'Port'` — `inputCount` inference when test data has no `\|` separator |
| `src/headless/default-facade.ts` | 209 | `el.typeId === 'In' \|\| el.typeId === 'Clock'` | Add `'Port'` — duplicated `inputCount` inference (same logic as test-runner) |
| `src/io/postmessage-adapter.ts` | 428–429 | `def.name === 'In' \|\| def.name === 'Clock'` / `def.name === 'Out'` | Add `'Port'` to both checks — tutorial test validation |
| `src/app/canvas-interaction.ts` | 550, 571 | `el.typeId === 'In' \|\| el.typeId === 'Clock'` | Add `'Port'` — click-to-toggle signal driving in the canvas |

### What Does NOT Need Changing

These subsystems are already Port-compatible via `labelSignalMap` delegation:

| File | Why no change needed |
|------|---------------------|
| `src/headless/runner.ts` | `setInput()`/`readOutput()`/`readAllSignals()` all use `labelSignalMap.get(label)` — no typeId checks |
| `src/testing/executor.ts` | Receives pre-split `inputNames`/`outputNames` arrays — no typeId checks |
| `src/integration/editor-binding.ts` | Wire→signal and pin→signal maps are pre-built by compiler — no typeId checks |
| `src/solver/digital/compiled-circuit.ts` | Pure data structure — no detection logic |
| `src/solver/digital/bus-resolution.ts` | Bus conflict detection is purely numeric (net IDs, not typeIds) |

### `inputCount` Inference Note

The `inputCount` inference in `test-runner.ts` and `default-facade.ts` determines the input/output column split when test data lacks a `|` separator. For Port (bidirectional), the inference should count Port labels as **input-capable** — the convention is that test vector inputs are driven (written), outputs are sampled (read). Users can override the split by placing `|` in the test data.

### Legacy Compatibility

Existing `.dig` files with `In`/`Out` continue to work unchanged. The long-term goal is for `Port` to be the sole interface element, with `In`/`Out` recognized only for backward compatibility during loading.
