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

The `if (nodeCathode > 0)` guard is required because ButtonLED's cathode is structurally allowed to be ground (and is, in the current implementation). Per BATCH1-D2 Option C (engine spec §A6.6), shunt-to-ground-possible elements MUST guard their allocElement calls. This guard is not optional and is not removable in future variants.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral — per 02-behavioral.md §Pin-map field).
- `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

The current implementation returns a plain `AnalogElementCore` — no `poolBacked`, no `stateSize`, no `initState`. This is unchanged. ButtonLED has no state pool slots.

## Dependency on SEVENSEG migration

**Dependency on createSegmentDiodeElement.setup()**: the helper's `setup()` body lands in W2 per W2.6 (see plan.md §"Wave plan" and 00-engine.md §A3.2). The PB-BEHAV-BUTTONLED W3 task does NOT write the helper — it only confirms the helper has a `setup` property. This eliminates the previously-documented race with PB-BEHAV-SEVENSEG.

## Verification gate

1. Existing test file `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN.
- **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
2. No `allocElement` call in load() body. Verified by: `Grep "allocElement" src/solver/analog/behavioral-remaining.ts` returns only matches inside `setup()` method bodies.
3. `setup()` forward order is output pin → LED diode (Shape rule 8).
4. `SegmentDiodeElement.setup()` exists (dependency on SEVENSEG migration).
5. No banned closing verdicts.
