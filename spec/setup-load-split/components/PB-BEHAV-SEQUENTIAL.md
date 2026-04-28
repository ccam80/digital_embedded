# Task PB-BEHAV-SEQUENTIAL

**digiTS file:** `src/solver/analog/behavioral-sequential.ts`
**Element classes:**
- `BehavioralCounterElement` — N-bit edge-triggered counter with overflow output
- `BehavioralRegisterElement` — N-bit parallel-load register
- `BehavioralCounterPresetElement` — N-bit up/down counter with preset load and clear

**ngspice anchor:** NONE — behavioral elements. setup() bodies match the
existing per-pin-model alloc pattern from `02-behavioral.md` Shape rules
1, 2, 3. NOT bound by ngspice line-for-line equivalence.

This single spec covers all three classes — they all live in
`behavioral-sequential.ts`, share the `SEQUENTIAL_COMPOSITE_SCHEMA`
(empty), and follow Shape rule 3.

## Bus-shared-node `allocElement` idempotence rule

All three classes use **multi-bit bus pins** where multiple per-bit
`DigitalInputPinModel` / `DigitalOutputPinModel` instances share the same
MNA node id. Examples:
- `BehavioralCounterPresetElement._inBitPins[0..N-1]` all share the
  `pinNodes.get("in")` bus node.
- `BehavioralRegisterElement._dataPins[0..N-1]` all share the
  `pinNodes.get("D")` bus node.
- `BehavioralRegisterElement._outBitPins[0..N-1]` all share the
  `pinNodes.get("Q")` bus node.

Each per-bit pin model independently calls `solver.allocElement(busNodeId,
busNodeId)` during its `setup()` (per Shape rule 1 / Shape rule 2 role
"direct"). `SparseSolver.allocElement` returns the existing handle on
subsequent calls to the same coordinates (idempotent by design — same
mechanism PB-DIO uses for the RS=0 collapse case). **Each pin model still
needs its own `_hNodeDiag` populated by setup(), so de-duplication is not
permitted at the spec level — every pin model independently calls
allocElement.** The handle returned is the same per-bus, but the field
storing it is per-pin-model.

## Class 1: `BehavioralCounterElement`

### Composition

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel | 3 | en, C, clr |
| DigitalOutputPinModel | bitWidth + 1 | `out_0`..`out_{bitWidth-1}` (per-bit, all share `out` bus node), plus `ovf` (own node) |
| AnalogCapacitorElement (child) | dynamic | Created by pin model `init` when loaded && cIn/cOut > 0 |

### Pin layout

| Pin label | Direction | Notes |
|---|---|---|
| `en` | input | Enable |
| `C` | input | Clock (rising-edge) |
| `clr` | input | Clear (synchronous) |
| `out` | output (multi-bit bus) | Single bus node; `bitWidth` per-bit pin models share it |
| `ovf` | output | Overflow flag (own node) |

### setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model
  this._enPin.setup(ctx);
  this._clockPin.setup(ctx);
  this._clrPin.setup(ctx);

  // Forward to every output pin model. The bitWidth out-bit pin models
  // all share one MNA node (the "out" bus node); each independently calls
  // allocElement(busNode, busNode) during its own setup. allocElement is
  // idempotent for repeated coordinates, so all bit-pin models receive
  // the same handle in their _hNodeDiag fields.
  for (const pin of this._outBitPins) pin.setup(ctx);
  this._ovfPin.setup(ctx);

  // Forward to every capacitor child collected from all pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

### TSTALLOC count

Per pin model: 1 × `(node, node)`. Total before capacitor children:
**`3 + bitWidth + 1 = bitWidth + 4`** independent `allocElement` calls.
Of these, the `bitWidth` out-bit calls all hit the same coordinates and
collapse to a single matrix entry (one structurally meaningful entry on
the `out` bus diagonal).

Examples:
- bitWidth=1: 5 allocElement calls → 5 distinct matrix entries
  (en, C, clr, out, ovf — each its own diagonal)
- bitWidth=4: 8 allocElement calls → 5 distinct matrix entries
  (en, C, clr, out [shared bus diagonal], ovf)
- bitWidth=8: 12 allocElement calls → 5 distinct matrix entries

Capacitor children add 4 entries each (per `PB-CAP.md`).

## Class 2: `BehavioralRegisterElement`

### Composition

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel | bitWidth + 2 | `bitWidth` data pins (all on D bus), C, en |
| DigitalOutputPinModel | bitWidth | `bitWidth` per-bit pin models all on Q bus |
| AnalogCapacitorElement (child) | dynamic | |

### Pin layout

| Pin label | Direction | Notes |
|---|---|---|
| `D` | input (multi-bit bus) | Single bus node; `bitWidth` per-bit pin models share it |
| `C` | input | Clock |
| `en` | input | Enable |
| `Q` | output (multi-bit bus) | Single bus node; `bitWidth` per-bit pin models share it |

### setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every data pin model. All bitWidth pin models share the
  // single "D" bus node; each independently calls allocElement(D, D)
  // during its setup, all returning the same handle (idempotent).
  for (const pin of this._dataPins) pin.setup(ctx);

  // Single-node input pins
  this._clockPin.setup(ctx);
  this._enPin.setup(ctx);

  // Forward to every output pin model. All bitWidth out-bit models share
  // the single "Q" bus node.
  for (const pin of this._outBitPins) pin.setup(ctx);

  // Forward to every capacitor child collected from all pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

### TSTALLOC count

**`bitWidth + 2 + bitWidth = 2 × bitWidth + 2`** allocElement calls. After
shared-bus collapse: 4 distinct matrix entries (D bus diagonal, C diagonal,
en diagonal, Q bus diagonal).

Capacitor children add 4 entries each.

## Class 3: `BehavioralCounterPresetElement`

### Composition

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel | 5 + bitWidth | en, C, dir, `bitWidth` in-bit (all on `in` bus), ld, clr |
| DigitalOutputPinModel | bitWidth + 1 | `bitWidth` out-bit (all on `out` bus), ovf |
| AnalogCapacitorElement (child) | dynamic | |

### Pin layout

| Pin label | Direction | Notes |
|---|---|---|
| `en` | input | Enable |
| `C` | input | Clock |
| `dir` | input | Direction (0 = up, 1 = down) |
| `in` | input (multi-bit bus) | Preset load value; `bitWidth` per-bit pin models share the bus node |
| `ld` | input | Load enable (priority: ld > count) |
| `clr` | input | Clear (priority: clr > ld) |
| `out` | output (multi-bit bus) | `bitWidth` per-bit pin models share the bus node |
| `ovf` | output | Overflow flag |

### setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model
  this._enPin.setup(ctx);
  this._clockPin.setup(ctx);
  this._dirPin.setup(ctx);
  // bitWidth in-bit pin models all share the "in" bus node.
  for (const pin of this._inBitPins) pin.setup(ctx);
  this._ldPin.setup(ctx);
  this._clrPin.setup(ctx);

  // Forward to every output pin model. bitWidth out-bit models share the
  // "out" bus node. ovf has its own node.
  for (const pin of this._outBitPins) pin.setup(ctx);
  this._ovfPin.setup(ctx);

  // Forward to every capacitor child collected from all pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

### TSTALLOC count

**`5 + bitWidth + bitWidth + 1 = 2 × bitWidth + 6`** allocElement calls.
After shared-bus collapse: 7 distinct matrix entries (en, C, dir, in bus,
ld, clr, out bus, ovf — wait that's 8; let me recount: en, C, dir, in
bus diagonal, ld, clr, out bus diagonal, ovf = **8 distinct** matrix
entries).

Capacitor children add 4 entries each.

## load() body — value writes only

The existing `load()` bodies on all three classes stamp through pin models.
No `solver.allocElement` calls remain after pin-model migration.
`accept()`, `getPinCurrents()`, and the count/storedValue/etc. internal
state machinery are unchanged.

## Forward order

Inputs → outputs → children (per Shape rule 3) for all three classes.

## Factory cleanup

For each class's analog factory (`makeBehavioralCounterAnalogFactory`,
`makeBehavioralRegisterAnalogFactory`,
`makeBehavioralCounterPresetAnalogFactory`):

- Drop `internalNodeIds` and `branchIdx` from the factory closure signature
  per A6.3.
- `ComponentDefinition.ngspiceNodeMap` left undefined.
- `MnaModel.mayCreateInternalNodes`: `false`.
- `MnaModel.findBranchFor`: omitted.
- Class declarations of `poolBacked` and `SEQUENTIAL_COMPOSITE_SCHEMA`
  unchanged.

`BehavioralCounterPresetElement` does not currently declare an `s0..s7`
typed-array slot block (lines 540-551 of source). Per the
`ReactiveAnalogElementCore` contract, an `initVoltages(rhs)` method is
also expected on this class. The implementer adds the missing
`s0..s7: Float64Array<ArrayBufferLike>` declarations and the standard
`initVoltages(rhs)` body (`this._prevClockVoltage = readMnaVoltage(this._clockPin.nodeId, rhs)`)
to bring this class in line with the other two — this is a pre-existing
class-shape gap surfaced by the migration; not new work.

## State pool

The composite schema is empty (`SEQUENTIAL_COMPOSITE_SCHEMA` defined as
`defineStateSchema("BehavioralSequentialComposite", [])`). `stateSize`
aggregates from `_childElements[].stateSize`. `stateBaseOffset` is set
by `MNAEngine._setup()` via `allocateStateBuffers` per `00-engine.md`
§A5.1. `initState(pool)` distributes offsets to children via the
existing inline pattern (preserved unchanged).

The composites participate in the unified state pool via `isPoolBacked`
filter at construction in `ckt-context.ts:616`. No new mechanism.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is
spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in `BehavioralCounterElement` matches the Class 1 block
   line-for-line.
2. `setup()` body in `BehavioralRegisterElement` matches the Class 2 block
   line-for-line.
3. `setup()` body in `BehavioralCounterPresetElement` matches the Class 3
   block line-for-line.
4. Forward order is inputs → outputs → children for all three.
5. Factory cleanup applied per the "Factory cleanup" section for all three
   factories.
6. No `solver.allocElement(...)` calls inside `load()`, `accept()`, or any
   non-`setup()` method on any of the three classes.
7. `mayCreateInternalNodes: false` flag set on all three `MnaModel` entries.
8. `ngspiceNodeMap` left undefined on all three `ComponentDefinition`s.
9. `BehavioralCounterPresetElement` has the standard `s0..s7` typed-array
   slot block and `initVoltages(rhs)` method matching the other two
   classes (class-shape gap closure).
10. No banned closing verdicts used in any commit message or report.
