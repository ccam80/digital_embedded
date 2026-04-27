# Task PB-BEHAV-NOT

**digiTS file:** `src/solver/analog/behavioral-gate.ts` (factory: `makeNotAnalogFactory`)
**Element class:** `BehavioralGateElement`
**ngspice anchor:** NONE — behavioral element. setup() body matches the existing alloc block extracted from the current `load()` path (per 02-behavioral.md). NOT bound by ngspice line-for-line equivalence.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel | 1 | Pin label `In_1` |
| DigitalOutputPinModel | 1 | Pin label `out`, role `"direct"` |
| AnalogCapacitorElement (child) | dynamic | Created by DigitalInputPinModel.init / DigitalOutputPinModel.init when loaded && cIn/cOut > 0; collected via `collectPinModelChildren` |

## Pin layout (per pinLayout order)

1. `In_1` — single input
2. `out` — inverted output

The NOT gate always has exactly 1 input. `makeNotAnalogFactory` calls `buildGateElement(pinNodes, 1, notTruth, props)` — `inputCount` is hardcoded to 1, not read from props.

## setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model (DigitalInputPinModel.setup per Shape rule 1)
  for (const pin of this._inputs) pin.setup(ctx);
  // Forward to output pin model (DigitalOutputPinModel.setup per Shape rule 2, role "direct")
  this._output.setup(ctx);
  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: inputs → output → children (per Shape rule 3).

## load() body — value writes only (no allocElement)

Implementer keeps the existing `load()` body verbatim BUT removes any `solver.allocElement` calls. Pin models stamp through the handles cached during their `setup()`. Capacitor children stamp through their own cached handles. The truth-table evaluation (`notTruth`), latching logic (`_latchedLevels`), and `_output.setLogicLevel(outputBit)` remain unchanged.

## Pin model TSTALLOCs (from 02-behavioral.md Shape rules 1, 2)

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)` — the `_hNodeDiag` entry.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)` — the `_hNodeDiag` entry.

For NOT (1 input + 1 output): total TSTALLOC count = **2** (when both loaded). Capacitor children add their own 4 entries each.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` from the `makeNotAnalogFactory` closure signature (per A6.3). The factory currently ignores them (`_internalNodeIds`, `_branchIdx`); remove the parameters entirely once A6.3 lands.
- `ComponentDefinition`: `ngspiceNodeMap` left `undefined` (behavioral — per 02-behavioral.md §"Pin-map field on behavioral models").
- `MnaModel`: `hasBranchRow: false`, `mayCreateInternalNodes: false`.
- `BehavioralGateElement` adds a `setup(ctx: SetupContext): void` method per Shape rule 3.

## State pool

`BehavioralGateElement.stateSize` aggregates `_childElements[].stateSize` (capacitor children only; the composite schema `GATE_COMPOSITE_SCHEMA` is empty). `stateBaseOffset` is set by `MNAEngine._setup()` via `allocateStateBuffers` per `00-engine.md` §A5.1. `initState(pool)` distributes offsets to children (existing pattern in `BehavioralGateElement.initState` preserved unchanged).

## Verification gate

1. `src/solver/analog/__tests__/behavioral-gate.test.ts` (or equivalent test file for gates) is GREEN after the migration.
2. `Grep "allocElement" src/solver/analog/behavioral-gate.ts` returns only matches inside the `setup()` method body (zero matches in `load()`).
3. Composite `setup()` forward order is inputs → output → children (per Shape rule 3).
4. No banned closing verdicts in review comments or commit messages.
