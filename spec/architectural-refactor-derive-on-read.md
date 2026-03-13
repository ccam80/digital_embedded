# Architectural Refactor: Derive-on-Read Instead of Construction-Time Caching

## Problem

Every layer copies data into `readonly` fields at construction time rather than reading from a shared mutable source at use time. This creates a 7-layer snapshot chain where changing a single parameter (e.g. bitWidth on a subcircuit In element) requires tearing down and rebuilding the entire object graph:

```
XML → Circuit (cached) → PinLayout (frozen) → Registry (frozen)
    → Element._pins (readonly) → Wire.bitWidth (propagated once)
    → CompiledModel (built once)
```

None of these layers point back to the source — they all hold stale copies.

## Solution

Make hot paths (`draw()`, `getPins()`, `getBoundingBox()`, `compile()`) derive from properties on each call. Stop caching in intermediate layers.

### Performance Justification

- `getPins()`: ~50 arithmetic ops per element (2-10 pins × rotate + translate). With 100 elements = ~5,000 ops/frame = <0.1ms.
- `getBoundingBox()`: trivial arithmetic.
- `draw()`: already the most expensive part (canvas API calls). Pin/bbox computation is noise.
- Java Digital does exactly this (recomputes shapes every paint call) with no performance issue.
- Compilation already rebuilds from scratch — no difference.
- Only subcircuit pin derivation (walking child circuit In/Out elements) benefits from caching, and that can use a dirty flag on definition change rather than freezing everything downstream.

## Refactor Steps

### Step 1: Make `getPins()` derive from properties

**Current:** `readonly _pins` set once in constructor via `resolvePins()`.
**Target:** `getPins()` calls `resolvePins()` each time from current properties.

Files to change:
- `src/core/element.ts` — update AbstractCircuitElement base
- All component classes in `src/components/` — remove `readonly _pins` field, compute in `getPins()`
- `src/core/pin.ts` — `resolvePins()` is already pure, no changes needed

### Step 2: Make `getBoundingBox()` derive from properties

**Current:** Some components compute from frozen fields (e.g. `_withEnable`, `_bitWidth`).
**Target:** Read from `this._properties` directly in `getBoundingBox()`.

Most components already do this or nearly do — the main change is removing intermediate cached fields that duplicate property values.

### Step 3: Make SubcircuitDefinition live

**Current:** `SubcircuitDefinition.pinLayout` is a frozen `PinDeclaration[]` derived once at registration.
**Target:** `pinLayout` is derived on access from the live `circuit` reference.

Files:
- `src/components/subcircuit/subcircuit.ts` — make `pinLayout` a getter that calls `deriveInterfacePins(circuit)`
- `src/components/subcircuit/pin-derivation.ts` — already pure, no changes needed

### Step 4: Make SubcircuitElement derive pins from definition

**Current:** Constructor copies `definition.pinLayout` into `readonly _pins`.
**Target:** `getPins()` calls `resolvePins(definition.pinLayout, ...)` each time.

File: `src/components/subcircuit/subcircuit.ts`

Width/height should also derive from current `pinLayout` + circuit metadata rather than being frozen.

### Step 5: Make wire bitWidth a derived property

**Current:** `wire.bitWidth` is stamped once by `propagateWireBitWidths()` at load time.
**Target:** Wire bitWidth is derived during rendering from the pins it connects to, or re-propagated on any circuit mutation.

Options:
- **Option A (simpler):** Re-run `propagateWireBitWidths()` after any circuit edit that could change connectivity or pin widths. Called from the editor's mutation handlers.
- **Option B (cleaner):** Wires have no `bitWidth` field. The renderer queries pin bitWidths at connected endpoints to determine thickness. The compiler does the same.

Option A is the pragmatic first step. Option B is the end state.

Files:
- `src/io/dig-loader.ts` — extract `propagateWireBitWidths()` for reuse
- `src/editor/edit-operations.ts` — call after mutations
- `src/editor/wire-drawing.ts` — call after wire split/merge
- `src/core/circuit.ts` — optionally remove `wire.bitWidth` field (Option B)

### Step 6: Registry holds live references

**Current:** `registry.register()` stores a frozen ComponentDefinition. Re-registration is blocked with early return.
**Target:** Registry allows updating definitions. Subcircuit definitions hold a reference to the live SubcircuitDefinition object.

Files:
- `src/core/registry.ts` — add `update()` method or replace-on-register
- `src/io/subcircuit-loader.ts` — remove early-return guard, allow re-registration

### Step 7: Subcircuit cache invalidation

**Current:** `_subcircuitCache` in subcircuit-loader.ts blocks reloads. `clearSubcircuitCache()` exists but isn't called during editing.
**Target:** Cache is invalidated per-subcircuit when the file is modified or reloaded.

Files:
- `src/io/subcircuit-loader.ts` — add `invalidateSubcircuit(name)` function
- `src/app/app-init.ts` — call on file reload

## Migration Strategy

These steps are independent and can be done incrementally:
- Steps 1-2 are mechanical (remove cached fields, compute in getter) with zero API change
- Steps 3-4 fix the subcircuit bitwidth propagation problem
- Step 5 fixes wire rendering after edits
- Steps 6-7 fix subcircuit file reload

Each step should include updating the corresponding tests (many test helpers create elements with specific pin expectations — these need to work with derived pins).

## What NOT to change

- Compilation output (`CompiledModel`) should remain a frozen snapshot — it's the simulation's hot path and benefits from being pre-computed.
- `resolvePins()` and `deriveInterfacePins()` are already pure functions — they just need to be called more often.
- The `.dig` XML loader doesn't need changes — it produces Circuit objects that are the source of truth.
