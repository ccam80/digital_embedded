# Task PB-BEHAV-DECODER

**digiTS file:** `src/solver/analog/behavioral-combinational.ts` (factory: `makeBehavioralDecoderAnalogFactory`)
**Element class:** `BehavioralDecoderElement`
**ngspice anchor:** NONE — behavioral element. setup() body matches the existing alloc block extracted from the current `load()` path (per 02-behavioral.md). NOT bound by ngspice line-for-line equivalence.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel (selector) | `selectorBits` | All share the single `"sel"` MNA node; one model per selector bit |
| DigitalOutputPinModel | `2^selectorBits` | One per output, labels `"out_0"`...`"out_(N-1)"`, role `"direct"` |
| AnalogCapacitorElement (child) | dynamic | Created by pin model init when loaded && cIn/cOut > 0; collected via `collectPinModelChildren` over `[...selPins, ...outPins]` |

The decoder has no separate data input — it is a pure selector-to-one-hot converter. There is no `_inPin` field; this distinguishes it from the demux.

## Pin layout (per pinLayout order)

Labels in pinLayout order (matching `buildDecoderPinDeclarations` as referenced in the factory comment):

1. `sel` — selector bus (one MNA node; `selectorBits` `DigitalInputPinModel` instances share it)
2. `out_0` — first output (1-bit, own MNA node); HIGH when sel = 0
3. `out_1` — second output; HIGH when sel = 1
4. ...
5. `out_(2^selectorBits - 1)` — last output

For `selectorBits = 1`: pins are `sel`, `out_0`, `out_1` (3 pins, 2 outputs).
For `selectorBits = 2`: pins are `sel`, `out_0`...`out_3` (5 pins, 4 outputs).
For `selectorBits = 3`: pins are `sel`, `out_0`...`out_7` (9 pins, 8 outputs).

Decoder outputs are always 1-bit (no `bitWidth` property). Exactly one output is HIGH (the one whose index equals the selector integer); all others are LOW.

Note from source: `getPinCurrents` uses only `_selPins[0]` for the selector current contribution (all selector pin models share the same MNA node, so reading from `_selPins[0]` gives the node voltage once; the factory comment confirms this single-node architecture).

## setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every selector pin model (selectorBits models, all on sel node)
  // (DigitalInputPinModel.setup per Shape rule 1)
  for (const pin of this._selPins) pin.setup(ctx);

  // Forward to every output pin model (2^selectorBits models, one per output node)
  // (DigitalOutputPinModel.setup per Shape rule 2, role "direct")
  for (const pin of this._outPins) pin.setup(ctx);

  // Forward to every capacitor child collected from all pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: selector pins → output pins → children (inputs before outputs before children, per Shape rule 3).

## load() body — value writes only (no allocElement)

Implementer keeps the existing `load()` body verbatim BUT removes any `solver.allocElement` calls. Pin models stamp through the handles cached during their `setup()`. Capacitor children stamp through their own cached handles. The selector decode loop, one-hot output logic (`i === sel`), and per-output `setLogicLevel`/`load` calls all remain unchanged.

## Pin model TSTALLOCs (from 02-behavioral.md Shape rules 1, 2)

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)`.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)`.

**Note on shared-node calls:** the `selectorBits` selector pin models all share the same `selNodeId`. Each independently calls `allocElement(selNodeId, selNodeId)` during setup. `SparseSolver.allocElement` returns the existing handle on subsequent calls to the same coordinates. Each model still needs its own `_hNodeDiag` populated, so de-duplication is not permitted.

TSTALLOC count formula (before capacitor children):
- Selector pins: `selectorBits` × 1 (all to same `(selNode, selNode)`)
- Output pins: `2^selectorBits` × 1
- Total: `selectorBits + 2^selectorBits`

Example (selectorBits=1): 1 + 2 = **3 TSTALLOCs** (before capacitors).
Example (selectorBits=2): 2 + 4 = **6 TSTALLOCs** (before capacitors).
Example (selectorBits=3): 3 + 8 = **11 TSTALLOCs** (before capacitors).

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` from the `makeBehavioralDecoderAnalogFactory` closure signature (per A6.3). The factory currently ignores them (`_internalNodeIds`, `_branchIdx`); remove the parameters entirely once A6.3 lands.
- `ComponentDefinition`: `ngspiceNodeMap` left `undefined` (behavioral — per 02-behavioral.md §"Pin-map field on behavioral models").
- `MnaModel`: `hasBranchRow: false`, `mayCreateInternalNodes: false`.
- `BehavioralDecoderElement` adds a `setup(ctx: SetupContext): void` method per Shape rule 3.

## State pool

`BehavioralDecoderElement.stateSize` aggregates `_childElements[].stateSize` (capacitor children only; `COMBINATIONAL_COMPOSITE_SCHEMA` is empty). `stateBaseOffset` is set by `MNAEngine._setup()` via `allocateStateBuffers` per `00-engine.md` §A5.1. `initState(pool)` distributes offsets to children (existing pattern in `BehavioralDecoderElement.initState` preserved unchanged).

## Verification gate

1. `src/solver/analog/__tests__/behavioral-combinational.test.ts` (or equivalent test file) is GREEN after the migration.
2. `Grep "allocElement" src/solver/analog/behavioral-combinational.ts` returns only matches inside the `setup()` method body (zero matches in `load()`).
3. Composite `setup()` forward order is selector pins → output pins → children (per Shape rule 3, inputs before outputs before children).
4. No banned closing verdicts in review comments or commit messages.
