# Task PB-BEHAV-MUX

**digiTS file:** `src/solver/analog/behavioral-combinational.ts` (factory: `makeBehavioralMuxAnalogFactory`)
**Element class:** `BehavioralMuxElement`
**ngspice anchor:** NONE- behavioral element. setup() body matches the existing alloc block extracted from the current `load()` path (per 02-behavioral.md). NOT bound by ngspice line-for-line equivalence.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel (selector) | `selectorBits` | All share the single `"sel"` MNA node; one model per selector bit |
| DigitalInputPinModel (data) | `(2^selectorBits) × bitWidth` | 2D array `_dataPins[inputIdx][bitIdx]`; each group shares the `"in_i"` MNA node |
| DigitalOutputPinModel | `bitWidth` | All share the single `"out"` MNA node; one model per output bit, role `"direct"` |
| AnalogCapacitorElement (child) | dynamic | Created by pin model init when loaded && cIn/cOut > 0; collected via `collectPinModelChildren` over `[...selPins, ...dataPins.flat(), ...outPins]` |

## Pin layout (per pinLayout order)

The factory reads pin nodes via `pinNodes.get(label)`. Labels in pinLayout order:

1. `sel`- selector bus (one MNA node; internally modelled as `selectorBits` separate `DigitalInputPinModel` instances sharing that node)
2. `in_0`- first data input bus (one MNA node; `bitWidth` `DigitalInputPinModel` instances share it)
3. `in_1`- second data input bus
4. ...
5. `in_(2^selectorBits - 1)`- last data input bus
6. `out`- output bus (one MNA node; `bitWidth` `DigitalOutputPinModel` instances share it)

For `selectorBits = 1, bitWidth = 1`: pins are `sel`, `in_0`, `in_1`, `out` (4 pins, 2 data inputs).
For `selectorBits = 2, bitWidth = 1`: pins are `sel`, `in_0`...`in_3`, `out` (6 pins, 4 data inputs).

Note: the bus model means each named pin maps to a single MNA node regardless of `bitWidth`. Multiple pin models are constructed per bus node to model per-bit loading, but they all call `allocElement` on the same `nodeId`.

## setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every selector pin model (selectorBits models, all on sel node)
  // (DigitalInputPinModel.setup per Shape rule 1)
  for (const pin of this._selPins) pin.setup(ctx);

  // Forward to every data pin model (2D loop: inputCount groups × bitWidth models)
  // Each model in a group shares the same MNA node as the others in that group.
  for (const group of this._dataPins) {
    for (const pin of group) pin.setup(ctx);
  }

  // Forward to every output pin model (bitWidth models, all on out node)
  // (DigitalOutputPinModel.setup per Shape rule 2, role "direct")
  for (const pin of this._outPins) pin.setup(ctx);

  // Forward to every capacitor child collected from all pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: selector pins → data pins → output pins → children (inputs before outputs before children, per Shape rule 3).

## load() body- value writes only (no allocElement)

Implementer keeps the existing `load()` body verbatim BUT removes any `solver.allocElement` calls. Pin models stamp through the handles cached during their `setup()`. Capacitor children stamp through their own cached handles. The selector decode loop, data routing logic (`selectedGroup = _dataPins[sel]`), output `setLogicLevel` and `load` calls all remain unchanged.

## Pin model TSTALLOCs (from 02-behavioral.md Shape rules 1, 2)

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)`.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)`.

**Important:** multiple pin models sharing the same MNA node each call `allocElement(node, node)`. Because `SparseSolver.allocElement` returns the existing handle when called twice with the same `(row, col)` coordinates, the duplicate calls are safe but do contribute to insertion-order records. The implementer must not de-duplicate these calls- each model must call `setup(ctx)` independently so its own `_hNodeDiag` field is populated.

TSTALLOC count formula (before capacitor children):
- Selector pins: `selectorBits` × 1 (all on same node- `selectorBits` calls to same `(selNode, selNode)`)
- Data pins: `(2^selectorBits) × bitWidth` × 1 (each group's models share `in_i` node)
- Output pins: `bitWidth` × 1 (all on same `out` node)
- Total: `selectorBits + (2^selectorBits × bitWidth) + bitWidth`

Example (selectorBits=1, bitWidth=1): 1 + 2 + 1 = **4 TSTALLOCs** (before capacitors).
Example (selectorBits=2, bitWidth=1): 2 + 4 + 1 = **7 TSTALLOCs** (before capacitors).

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` from the `makeBehavioralMuxAnalogFactory` closure signature (per A6.3). The factory currently ignores them (`_internalNodeIds`, `_branchIdx`); remove the parameters entirely once A6.3 lands.
- `ComponentDefinition`: `ngspiceNodeMap` left `undefined` (behavioral- per 02-behavioral.md ss"Pin-map field on behavioral models").
- `MnaModel`: `mayCreateInternalNodes: false`.
- `BehavioralMuxElement` adds a `setup(ctx: SetupContext): void` method per Shape rule 3.

## State pool

The combinational composite element schema declares no state slots of its own- all state comes from capacitor children. setup() does not call `ctx.allocStates(...)` for the composite itself; child capacitor sub-elements call `ctx.allocStates(2)` each (per indsetup.c-style state allocation for inductors / capsetup.c-style for caps; see PB-CAP ssState slots for the per-capacitor count).

If you need to verify the existing source constant name (e.g., `COMBINATIONAL_COMPOSITE_SCHEMA`), the spec author should pin it down here- leave the implementer with a behavioral description, not a source-name reference.

`BehavioralMuxElement.stateSize` aggregates `_childElements[].stateSize`. `stateBaseOffset` is set by `MNAEngine._setup()` via `allocateStateBuffers` per `00-engine.md` ssA5.1. `initState(pool)` distributes offsets to children (existing pattern in `BehavioralMuxElement.initState` preserved unchanged).

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body- alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only- zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
