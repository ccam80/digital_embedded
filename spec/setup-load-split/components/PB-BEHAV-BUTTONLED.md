# Task PB-BEHAV-BUTTONLED

**digiTS file:** `src/solver/analog/behavioral-remaining.ts` (factory: `createButtonLEDAnalogElement`)
**ngspice anchor:** NONE — behavioral. setup() body replicates the existing `allocElement` calls embedded in `stampG()` within `SegmentDiodeElement.load()` and `DigitalOutputPinModel.load()` (per 02-behavioral.md Shape rule 8).

## Composition (per 02-behavioral.md Shape rule 8)

| Sub-element | Type | Count |
|---|---|---|
| `outputPin` | `DigitalOutputPinModel` (role="direct") | 1 (button output) |
| `ledDiode` | `SegmentDiodeElement` (inline closure) | 1 (LED, anode=nodeLedIn, cathode=0) |

There are no `DigitalInputPinModel` sub-elements. There are no capacitor children (current implementation returns a plain `AnalogElementCore` without `collectPinModelChildren`).

## Pin layout

| Position | Label | Role |
|---|---|---|
| 0 | `out` | button output — `DigitalOutputPinModel` (role="direct") |
| 1 | `in` | LED anode — `SegmentDiodeElement(nodeLedIn, 0)` |

`nodeOut = pinNodes.get("out")!`, `nodeLedIn = pinNodes.get("in")!`.

## setup() body

The current factory returns a plain object literal. Add a `setup(ctx)` property to the existing returned object literal — no class refactor required.

```ts
// inside the existing return { ... } block in createButtonLEDAnalogElement:
setup(ctx: SetupContext): void {
  outputPin.setup(ctx);
  ledDiode.setup(ctx);
},
```

Forward order: **output pin → LED diode** per 02-behavioral.md Shape rule 8. No input pins; no child capacitors.

`DigitalOutputPinModel.setup(ctx)` for role="direct" allocates `(nodeOut, nodeOut)` per Shape rule 2.

`SegmentDiodeElement.setup(ctx)` allocates per Shape rule 7:
- `_hAA = allocElement(nodeLedIn, nodeLedIn)` if `nodeLedIn > 0`
- `_hCC = allocElement(0, 0)` — skipped because `nodeCathode = 0` and the guard `if (nodeCathode > 0)` fires false
- `_hAC`, `_hCA` — skipped for the same reason

So for ButtonLED's LED diode only `_hAA` is allocated (same as SevenSeg segment diodes).

## load() body — value writes only

Existing load() body kept verbatim minus any `solver.allocElement` calls. The `stampG()` helper in `ledDiode.load()` is replaced by `stampElement(_hAA, geq)` (no cross-terms since cathode=0). `outputPin.load()` stamps through its cached `_hNodeDiag` handle:

```ts
load(ctx: LoadContext): void {
  outputPin.load(ctx);  // stamps via cached _hNodeDiag
  ledDiode.load(ctx);   // stamps via cached _hAA (no _hCC/_hAC/_hCA — cathode=0)
},
```

No `allocElement` calls remain in load() after migration.

## Pin model TSTALLOCs

| Sub-element | allocElement calls | Condition |
|---|---|---|
| `outputPin` (DigitalOutputPinModel, role="direct") | `(nodeOut, nodeOut)` | if nodeOut > 0 |
| `ledDiode` (SegmentDiodeElement) | `(nodeLedIn, nodeLedIn)` (`_hAA`) | if nodeLedIn > 0 |
| `ledDiode` `_hCC` | `(0, 0)` | NEVER — cathode = 0, guard prevents alloc |
| `ledDiode` `_hAC`, `_hCA` | cross-terms | NEVER — cathode = 0, guard prevents alloc |

Total matrix entries added by setup(): up to 2 (one for output pin, one for LED diode anode diagonal).

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral — per 02-behavioral.md §Pin-map field).
- `hasBranchRow: false`, `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

The current implementation returns a plain `AnalogElementCore` — no `poolBacked`, no `stateSize`, no `initState`. This is unchanged. ButtonLED has no state pool slots.

## Dependency on SEVENSEG migration

`SegmentDiodeElement.setup()` is defined once inside `createSegmentDiodeElement` in `behavioral-remaining.ts`. The SEVENSEG migration task adds that method. ButtonLED uses the same helper, so the SEVENSEG agent's work on `createSegmentDiodeElement` covers ButtonLED's LED diode automatically. The ButtonLED agent must confirm `createSegmentDiodeElement` has a `setup(ctx)` method before marking GREEN.

## Verification gate

1. Existing test file `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN.
2. No `allocElement` call in load() body. Verified by: `Grep "allocElement" src/solver/analog/behavioral-remaining.ts` returns only matches inside `setup()` method bodies.
3. `setup()` forward order is output pin → LED diode (Shape rule 8).
4. `SegmentDiodeElement.setup()` exists (dependency on SEVENSEG migration).
5. No banned closing verdicts.
