# Task PB-BEHAV-DEMUX

**digiTS file:** `src/solver/analog/behavioral-combinational.ts` (factory: `makeBehavioralDemuxAnalogFactory`)
**Element class:** `BehavioralDemuxElement`
**ngspice anchor:** NONE- behavioral element. setup() body matches the existing alloc block extracted from the current `load()` path (per 02-behavioral.md). NOT bound by ngspice line-for-line equivalence.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel (selector) | `selectorBits` | All share the single `"sel"` MNA node; one model per selector bit |
| DigitalInputPinModel (data in) | 1 | Pin label `"in"`, single data input |
| DigitalOutputPinModel | `2^selectorBits` | One per output, labels `"out_0"`...`"out_(N-1)"`, role `"direct"` |
| AnalogCapacitorElement (child) | dynamic | Created by pin model init when loaded && cIn/cOut > 0; collected via `collectPinModelChildren` over `[...selPins, inPin, ...outPins]` |

## Pin layout (per pinLayout order)

Labels in pinLayout order (matching `buildDemuxPinDeclarations` as referenced in the factory comment):

1. `sel`- selector bus (one MNA node; `selectorBits` `DigitalInputPinModel` instances share it)
2. `out_0`- first output (1-bit, own MNA node)
3. `out_1`- second output
4. ...
5. `out_(2^selectorBits - 1)`- last output
6. `in`- data input bus (one MNA node)

For `selectorBits = 1`: pins are `sel`, `out_0`, `out_1`, `in` (4 pins, 2 outputs).
For `selectorBits = 2`: pins are `sel`, `out_0`...`out_3`, `in` (6 pins, 4 outputs).

Note: the output pins are 1-bit each (no `bitWidth` property on demux). The selected output receives the input signal level; all unselected outputs are driven LOW (`vOL`).

## setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every selector pin model (selectorBits models, all on sel node)
  // (DigitalInputPinModel.setup per Shape rule 1)
  for (const pin of this._selPins) pin.setup(ctx);

  // Forward to the data input pin model
  // (DigitalInputPinModel.setup per Shape rule 1)
  this._inPin.setup(ctx);

  // Forward to every output pin model (2^selectorBits models, one per output node)
  // (DigitalOutputPinModel.setup per Shape rule 2, role "direct")
  for (const pin of this._outPins) pin.setup(ctx);

  // Forward to every capacitor child collected from all pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: selector pins → input pin → output pins → children (inputs before outputs before children, per Shape rule 3).

## load() body- value writes only (no allocElement)

Implementer keeps the existing `load()` body verbatim BUT removes any `solver.allocElement` calls. Pin models stamp through the handles cached during their `setup()`. Capacitor children stamp through their own cached handles. The selector decode loop, input level read, output routing (`i === sel ? inLevel : false`), and per-output `setLogicLevel`/`load` calls all remain unchanged.

## Pin model TSTALLOCs (from 02-behavioral.md Shape rules 1, 2)

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)`.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)`.

**Note on shared-node calls:** the `selectorBits` selector pin models all share the same `selNodeId`. Each independently calls `allocElement(selNodeId, selNodeId)` during setup. `SparseSolver.allocElement` returns the existing handle on subsequent calls to the same coordinates, so this is safe. Each model still needs its own `_hNodeDiag` populated, so de-duplication is not permitted.

TSTALLOC count formula (before capacitor children):
- Selector pins: `selectorBits` × 1
- Input pin: 1
- Output pins: `2^selectorBits` × 1
- Total: `selectorBits + 1 + 2^selectorBits`

Example (selectorBits=1): 1 + 1 + 2 = **4 TSTALLOCs** (before capacitors).
Example (selectorBits=2): 2 + 1 + 4 = **7 TSTALLOCs** (before capacitors).

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` from the `makeBehavioralDemuxAnalogFactory` closure signature (per A6.3). The factory currently ignores them (`_internalNodeIds`, `_branchIdx`); remove the parameters entirely once A6.3 lands.
- `ComponentDefinition`: `ngspiceNodeMap` left `undefined` (behavioral- per 02-behavioral.md ss"Pin-map field on behavioral models").
- `MnaModel`: `mayCreateInternalNodes: false`.
- `BehavioralDemuxElement` adds a `setup(ctx: SetupContext): void` method per Shape rule 3.

## State pool

`BehavioralDemuxElement.stateSize` aggregates `_childElements[].stateSize` (capacitor children only; `COMBINATIONAL_COMPOSITE_SCHEMA` is empty). `stateBaseOffset` is set by `MNAEngine._setup()` via `allocateStateBuffers` per `00-engine.md` ssA5.1. `initState(pool)` distributes offsets to children (existing pattern in `BehavioralDemuxElement.initState` preserved unchanged).

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
