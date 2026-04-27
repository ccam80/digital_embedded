# Task PB-BEHAV-XNOR

**digiTS file:** `src/solver/analog/behavioral-gate.ts` (factory: `makeXnorAnalogFactory`)
**Element class:** `BehavioralGateElement`
**ngspice anchor:** NONE — behavioral element. setup() body matches the existing alloc block extracted from the current `load()` path (per 02-behavioral.md). NOT bound by ngspice line-for-line equivalence.

This single spec file covers XNOR-2, XNOR-3, XNOR-4, and any N-input XNOR variant. The factory signature is `makeXnorAnalogFactory(inputCount: number)`. When `inputCount === 0` the factory reads `props.inputCount` at instantiation time (defaulting to 2). The truth function `xnorTruth` negates `xorTruth` — HIGH when an even number of inputs are HIGH. The setup() for-loop over `this._inputs` covers all input counts without per-N branching.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel | N | One per input, labels `In_1`...`In_N` |
| DigitalOutputPinModel | 1 | Pin label `out`, role `"direct"` |
| AnalogCapacitorElement (child) | dynamic | Created by DigitalInputPinModel.init / DigitalOutputPinModel.init when loaded && cIn/cOut > 0; collected via `collectPinModelChildren` |

## Pin layout (per pinLayout order)

For an N-input XNOR gate:

1. `In_1` — first input
2. `In_2` — second input
3. ...
4. `In_N` — Nth input
5. `out` — XNOR output (HIGH when an even number of inputs are HIGH)

Pin labels follow the `In_${i+1}` pattern produced by `buildGateElement`'s loop. The output pin is always labelled `out`.

## setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model (DigitalInputPinModel.setup per Shape rule 1)
  // Covers XNOR-2, XNOR-3, XNOR-4, ..., XNOR-N without per-N branching.
  for (const pin of this._inputs) pin.setup(ctx);
  // Forward to output pin model (DigitalOutputPinModel.setup per Shape rule 2, role "direct")
  this._output.setup(ctx);
  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: inputs → output → children (per Shape rule 3).

## load() body — value writes only (no allocElement)

Implementer keeps the existing `load()` body verbatim BUT removes any `solver.allocElement` calls. Pin models stamp through the handles cached during their `setup()`. Capacitor children stamp through their own cached handles. The truth-table evaluation (`xnorTruth`), latching logic (`_latchedLevels`), and `_output.setLogicLevel(outputBit)` remain unchanged.

## Pin model TSTALLOCs (from 02-behavioral.md Shape rules 1, 2)

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)` — the `_hNodeDiag` entry.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)` — the `_hNodeDiag` entry.

For an N-input XNOR gate: total TSTALLOC count = **N + 1** (N input pins + 1 output pin, when all loaded). Capacitor children add their own 4 entries each (per `PB-CAP.md`).

Examples:
- XNOR-2: 3 TSTALLOCs (before capacitors)
- XNOR-3: 4 TSTALLOCs
- XNOR-4: 5 TSTALLOCs

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` from the `makeXnorAnalogFactory` closure signature (per A6.3). The factory currently ignores them (`_internalNodeIds`, `_branchIdx`); remove the parameters entirely once A6.3 lands.
- `ComponentDefinition`: `ngspiceNodeMap` left `undefined` (behavioral — per 02-behavioral.md §"Pin-map field on behavioral models").
- `MnaModel`: `hasBranchRow: false`, `mayCreateInternalNodes: false`.
- `BehavioralGateElement` adds a `setup(ctx: SetupContext): void` method per Shape rule 3. This method is shared across all gate variants using `BehavioralGateElement`.

## State pool

`BehavioralGateElement.stateSize` aggregates `_childElements[].stateSize` (capacitor children only; `GATE_COMPOSITE_SCHEMA` is empty). `stateBaseOffset` is set by `MNAEngine._setup()` via `allocateStateBuffers` per `00-engine.md` §A5.1. `initState(pool)` distributes offsets to children (existing pattern in `BehavioralGateElement.initState` preserved unchanged).

## Verification gate

1. `src/solver/analog/__tests__/behavioral-gate.test.ts` (or equivalent test file for gates) is GREEN after the migration.
2. `Grep "allocElement" src/solver/analog/behavioral-gate.ts` returns only matches inside the `setup()` method body (zero matches in `load()`).
3. Composite `setup()` forward order is inputs → output → children (per Shape rule 3).
4. No banned closing verdicts in review comments or commit messages.
