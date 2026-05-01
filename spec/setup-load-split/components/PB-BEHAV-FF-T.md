# Task PB-BEHAV-FF-T

**digiTS file:** `src/solver/analog/behavioral-flipflop/t.ts`
**Element class:** `BehavioralTFlipflopElement`
**ngspice anchor:** NONE- behavioral element. setup() body matches the
existing per-pin-model alloc pattern from `02-behavioral.md` Shape rules
1, 2, 3. NOT bound by ngspice line-for-line equivalence.

Single class with two pin layouts driven by the `withEnable: boolean`
component property. The factory `makeTFlipflopAnalogFactory()` branches on
`props.get("withEnable")` (default `true`) to choose between a 4-pin
(T/C/Q/~Q) or 3-pin (C/Q/~Q) layout. The element class field `_tPin` is
typed `DigitalInputPinModel | null` to handle the no-T-pin case.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count (withEnable) | Count (no enable) | Notes |
|---|---|---|---|
| DigitalInputPinModel | 2 | 1 | withEnable: T, C. No enable: C only. |
| DigitalOutputPinModel | 2 | 2 | Q, ~Q (role `"direct"`) for both. |
| AnalogCapacitorElement (child) | dynamic | dynamic | Created by pin model `init` when loaded && cIn/cOut > 0. |

Class-based (post-W2.5). Pool-backed via `FLIPFLOP_COMPOSITE_SCHEMA`
(empty), children own slots.

## Pin layouts

### withEnable=true (default, 2 inputs)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `T` | 0 | input | T enable input |
| `C` | 1 | input | Clock (rising-edge) |
| `Q` | 2 | output | Output |
| `~Q` | 3 | output | Inverted output |

### withEnable=false (1 input, toggle on every edge)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `C` | 0 | input | Clock (rising-edge) |
| `Q` | 1 | output | Output |
| `~Q` | 2 | output | Inverted output |

## setup() body

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model. _tPin is null when withEnable=false;
  // skip the forward in that case.
  if (this._tPin !== null) this._tPin.setup(ctx);
  this._clockPin.setup(ctx);

  // Forward to every output pin model (role "direct")
  this._qPin.setup(ctx);
  this._qBarPin.setup(ctx);

  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

The conditional `if (this._tPin !== null)` mirrors the existing `load()`
body at `behavioral-flipflop/t.ts:126` (`if (this._tPin !== null) this._tPin.load(ctx);`).
The single class supports both pin layouts via the nullable field.

Forward order: inputs → outputs → children (per Shape rule 3).

## load() body- value writes only

The existing `load()` body on the class stamps through pin models. No
`solver.allocElement` calls remain after pin-model migration. `accept()`
(which contains rising-edge detection and conditional toggle) and
`getPinCurrents()` are unchanged.

## Pin model TSTALLOC counts

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)`.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)`.

| Variant | Input pins | Output pins | TSTALLOC count (before children) |
|---|---|---|---|
| withEnable=true | 2 | 2 | **4** |
| withEnable=false | 1 | 2 | **3** |

Capacitor children add 4 entries each (per `PB-CAP.md`).

## Factory cleanup

For `makeTFlipflopAnalogFactory()`:

- Drop `internalNodeIds` and `branchIdx` from the factory closure signature
  per A6.3.
- `ComponentDefinition.ngspiceNodeMap` left undefined.
- `MnaModel.mayCreateInternalNodes`: `false`.
- `MnaModel.findBranchFor`: omitted.
- The factory branches on `withEnable` and constructs the same
  `BehavioralTFlipflopElement` class with `_tPin = null` in the no-enable
  branch- no class change required, only setup() body.
- Class declarations of `poolBacked` and `FLIPFLOP_COMPOSITE_SCHEMA`
  unchanged.

## State pool

Identical to PB-BEHAV-FF-D- composite schema is empty
(`FLIPFLOP_COMPOSITE_SCHEMA`); children own slots; `initChildState` helper
distributes offsets unchanged.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is
spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in `behavioral-flipflop/t.ts` matches the spec block
   line-for-line.
2. The `if (this._tPin !== null)` guard is present so the class supports
   both withEnable=true and withEnable=false factory branches.
3. Forward order is inputs → outputs → children.
4. Factory cleanup applied per the "Factory cleanup" section.
5. No `solver.allocElement(...)` calls inside `load()`, `accept()`, or any
   non-`setup()` method.
6. `mayCreateInternalNodes: false` flag set on the `MnaModel` entry.
7. `ngspiceNodeMap` left undefined on the `ComponentDefinition`.
8. No banned closing verdicts used in any commit message or report.
