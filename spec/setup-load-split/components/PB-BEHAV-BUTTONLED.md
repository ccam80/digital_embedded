# Task PB-BEHAV-BUTTONLED

**digiTS file:** `src/solver/analog/behavioral-remaining.ts` (factory: `createButtonLEDAnalogElement`)
**ngspice anchor:** NONE- behavioral. setup() body replicates the existing `allocElement` calls embedded in `stampG()` within `SegmentDiodeElement.load()` and `DigitalOutputPinModel.load()` (per 02-behavioral.md Shape rule 8).

## Composition (per 02-behavioral.md Shape rule 8)

| Sub-element | Type | Count |
|---|---|---|
| `outputPin` | `DigitalOutputPinModel` (role="direct") | 1 (button output) |
| `ledDiode` | `SegmentDiodeElement` (inline closure) | 1 (LED, anode=nodeLedIn, cathode=0) |

There are no `DigitalInputPinModel` sub-elements. There are no capacitor children (current implementation returns a plain `AnalogElementCore` without `collectPinModelChildren`).

## Pin layout

| Position | Label | Role |
|---|---|---|
| 0 | `out` | button output- `DigitalOutputPinModel` (role="direct") |
| 1 | `in` | LED anode- `SegmentDiodeElement(nodeLedIn, 0)` |

`nodeOut = pinNodes.get("out")!`, `nodeLedIn = pinNodes.get("in")!`.

## setup() body

The current factory returns a plain object literal. Add a `setup(ctx)` property to the existing returned object literal- no class refactor required.

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
- `_hCC = allocElement(0, 0)`- skipped because `nodeCathode = 0` and the guard `if (nodeCathode > 0)` fires false
- `_hAC`, `_hCA`- skipped for the same reason

So for ButtonLED's LED diode only `_hAA` is allocated (same as SevenSeg segment diodes).

## load() body- value writes only

Existing load() body kept verbatim minus any `solver.allocElement` calls. The `stampG()` helper in `ledDiode.load()` is replaced by `stampElement(_hAA, geq)` (no cross-terms since cathode=0). `outputPin.load()` stamps through its cached `_hNodeDiag` handle:

```ts
load(ctx: LoadContext): void {
  outputPin.load(ctx);  // stamps via cached _hNodeDiag
  ledDiode.load(ctx);   // stamps via cached _hAA (no _hCC/_hAC/_hCA- cathode=0)
},
```

No `allocElement` calls remain in load() after migration.

## Pin model TSTALLOCs

| Sub-element | allocElement calls | Condition |
|---|---|---|
| `outputPin` (DigitalOutputPinModel, role="direct") | `(nodeOut, nodeOut)` | if nodeOut > 0 |
| `ledDiode` (SegmentDiodeElement) | `(nodeLedIn, nodeLedIn)` (`_hAA`) | if nodeLedIn > 0 |
| `ledDiode` `_hCC` | `(0, 0)` | NEVER- cathode = 0, guard prevents alloc |
| `ledDiode` `_hAC`, `_hCA` | cross-terms | NEVER- cathode = 0, guard prevents alloc |

Total matrix entries added by setup(): up to 2 (one for output pin, one for LED diode anode diagonal).

The `if (nodeCathode > 0)` guard is required because ButtonLED's cathode is structurally allowed to be ground (and is, in the current implementation). Per BATCH1-D2 Option C (engine spec ssA6.6), shunt-to-ground-possible elements MUST guard their allocElement calls. This guard is not optional and is not removable in future variants.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral- per 02-behavioral.md ssPin-map field).
- `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

The current implementation returns a plain `AnalogElementCore`- no `poolBacked`, no `stateSize`, no `initState`. This is unchanged. ButtonLED has no state pool slots.

## Dependency on SEVENSEG migration

**Dependency on createSegmentDiodeElement.setup()**: the helper's `setup()` body lands in W2 per W2.6 (see plan.md ss"Wave plan" and 00-engine.md ssA3.2). The PB-BEHAV-BUTTONLED W3 task does NOT write the helper- it only confirms the helper has a `setup` property. This eliminates the previously-documented race with PB-BEHAV-SEVENSEG.

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
