# Task PB-BEHAV-AND

**digiTS file:** `src/solver/analog/behavioral-gate.ts` (factory: `makeAndAnalogFactory`)
**Element class:** `BehavioralGateElement`
**ngspice anchor:** NONE — behavioral element. setup() body matches the existing alloc block extracted from the current `load()` path (per 02-behavioral.md). NOT bound by ngspice line-for-line equivalence.

This single spec file covers AND-2, AND-3, AND-4, and any N-input AND variant. The factory signature is `makeAndAnalogFactory(inputCount: number)`. When `inputCount === 0` the factory reads `props.inputCount` at instantiation time (defaulting to 2). The setup() for-loop over `this._inputs` covers all input counts without per-N branching.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count | Notes |
|---|---|---|
| DigitalInputPinModel | N | One per input, labels `In_1`...`In_N` |
| DigitalOutputPinModel | 1 | Pin label `out`, role `"direct"` |
| AnalogCapacitorElement (child) | dynamic | Created by DigitalInputPinModel.init / DigitalOutputPinModel.init when loaded && cIn/cOut > 0; collected via `collectPinModelChildren` |

## Pin layout (per pinLayout order)

For an N-input AND gate:

1. `In_1` — first input
2. `In_2` — second input
3. ...
4. `In_N` — Nth input
5. `out` — AND output (HIGH only when all inputs HIGH)

Pin labels follow the `In_${i+1}` pattern produced by `buildGateElement`'s loop (`label = \`In_${i + 1}\``). The output pin is always labelled `out`.

## setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model (DigitalInputPinModel.setup per Shape rule 1)
  // Covers AND-2, AND-3, AND-4, ..., AND-N without per-N branching.
  for (const pin of this._inputs) pin.setup(ctx);
  // Forward to output pin model (DigitalOutputPinModel.setup per Shape rule 2, role "direct")
  this._output.setup(ctx);
  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: inputs → output → children (per Shape rule 3).

## load() body — value writes only (no allocElement)

Implementer keeps the existing `load()` body verbatim BUT removes any `solver.allocElement` calls. Pin models stamp through the handles cached during their `setup()`. Capacitor children stamp through their own cached handles. The truth-table evaluation (`andTruth`), latching logic (`_latchedLevels`), and `_output.setLogicLevel(outputBit)` remain unchanged.

## Pin model TSTALLOCs (from 02-behavioral.md Shape rules 1, 2)

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)` — the `_hNodeDiag` entry.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)` — the `_hNodeDiag` entry.

For an N-input AND gate: total TSTALLOC count = **N + 1** (N input pins + 1 output pin, when all loaded). Capacitor children add their own 4 entries each (per `PB-CAP.md`).

Examples:
- AND-2: 3 TSTALLOCs (before capacitors)
- AND-3: 4 TSTALLOCs
- AND-4: 5 TSTALLOCs

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` from the `makeAndAnalogFactory` closure signature (per A6.3). The factory currently ignores them (`_internalNodeIds`, `_branchIdx`); remove the parameters entirely once A6.3 lands.
- `ComponentDefinition`: `ngspiceNodeMap` left `undefined` (behavioral — per 02-behavioral.md §"Pin-map field on behavioral models").
- `MnaModel`: `mayCreateInternalNodes: false`.
- **`BehavioralGateElement.setup()` ownership**: the shared method's body lands in W2 per W2.7 (see plan.md §"Wave plan" and 00-engine.md §A3.2). This W3 task does NOT write the method — it CONFIRMS the method exists and that the class still imports correctly. The factory-cleanup work for this gate type (drop legacy fields per the standard PB-* factory-cleanup contract) remains in scope for this W3 task.

## State pool

`BehavioralGateElement.stateSize` aggregates `_childElements[].stateSize` (capacitor children only; `GATE_COMPOSITE_SCHEMA` is empty). `stateBaseOffset` is set by `MNAEngine._setup()` via `allocateStateBuffers` per `00-engine.md` §A5.1. `initState(pool)` distributes offsets to children (existing pattern in `BehavioralGateElement.initState` preserved unchanged).

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body — alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only — zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
