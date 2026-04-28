# Task PB-BEHAV-FF-RS

**digiTS files:**
- `src/solver/analog/behavioral-flipflop/rs.ts` (`BehavioralRSFlipflopElement` — clocked RS flip-flop)
- `src/solver/analog/behavioral-flipflop/rs-async.ts` (`BehavioralRSAsyncLatchElement` — **level-sensitive RS latch, no clock**)

**ngspice anchor:** NONE — behavioral elements. setup() body matches the
existing per-pin-model alloc pattern from `02-behavioral.md` Shape rules
1, 2, 3. NOT bound by ngspice line-for-line equivalence.

## Asymmetry caveat

Unlike the D and JK pairs (where the "async" variant is the sync class
plus async-Set/Clear pins), the RS pair is structurally different:

- **`BehavioralRSFlipflopElement`** — clocked, edge-triggered, S/R inputs
  sampled on the rising clock edge.
- **`BehavioralRSAsyncLatchElement`** — **level-sensitive latch**, no clock
  pin. Responds to S/R levels every accepted timestep. Pin layout has no
  `C` pin.

Both classes are RS-flavored but they are not the sync/async pair pattern
seen elsewhere. The shared spec acknowledges this; setup() bodies and pin
layouts differ accordingly.

Both classes emit a `rs-flipflop-both-set` diagnostic when S=R=HIGH (a
forbidden input combination); the diagnostic emission lives in `accept()`
and is unrelated to setup/load.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count (clocked RS) | Count (level latch) | Notes |
|---|---|---|---|
| DigitalInputPinModel | 3 | 2 | Clocked: S, C, R. Latch: S, R. |
| DigitalOutputPinModel | 2 | 2 | Q, ~Q (role `"direct"`) for both. |
| AnalogCapacitorElement (child) | dynamic | dynamic | Created by pin model `init` when loaded && cIn/cOut > 0. |

Class-based (post-W2.5). Pool-backed via `FLIPFLOP_COMPOSITE_SCHEMA`
(empty), children own slots.

## Pin layouts

### Clocked RS flip-flop (`BehavioralRSFlipflopElement`)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `S` | 0 | input | Set input |
| `C` | 1 | input | Clock (rising-edge) |
| `R` | 2 | input | Reset input |
| `Q` | 3 | output | Output |
| `~Q` | 4 | output | Inverted output |

### Level-sensitive RS latch (`BehavioralRSAsyncLatchElement`)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `S` | 0 | input | Set input (level-sensitive) |
| `R` | 1 | input | Reset input (level-sensitive) |
| `Q` | 2 | output | Output |
| `~Q` | 3 | output | Inverted output |

No clock pin. The latch responds to S/R levels every accepted timestep
in `accept()`.

## setup() body

### `BehavioralRSFlipflopElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model
  this._sPin.setup(ctx);
  this._clockPin.setup(ctx);
  this._rPin.setup(ctx);

  // Forward to every output pin model (role "direct")
  this._qPin.setup(ctx);
  this._qBarPin.setup(ctx);

  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

### `BehavioralRSAsyncLatchElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model (level-sensitive — no clock pin)
  this._sPin.setup(ctx);
  this._rPin.setup(ctx);

  // Forward to every output pin model (role "direct")
  this._qPin.setup(ctx);
  this._qBarPin.setup(ctx);

  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: inputs → outputs → children (per Shape rule 3).

## load() body — value writes only

The existing `load()` bodies on both classes stamp through pin models.
No `solver.allocElement` calls remain after pin-model migration.
`accept()` (which contains the diagnostic-emission logic for S=R=HIGH)
and `getPinCurrents()` are unchanged.

## Pin model TSTALLOC counts

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)`.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)`.

| Variant | Input pins | Output pins | TSTALLOC count (before children) |
|---|---|---|---|
| Clocked RS | 3 | 2 | **5** |
| Level-sensitive RS latch | 2 | 2 | **4** |

Capacitor children add 4 entries each (per `PB-CAP.md`).

## Factory cleanup

For each variant's analog factory (`makeRSFlipflopAnalogFactory`,
`makeRSAsyncLatchAnalogFactory`):

- Drop `internalNodeIds` and `branchIdx` from the factory closure signature
  per A6.3.
- `ComponentDefinition.ngspiceNodeMap` left undefined.
- `MnaModel.mayCreateInternalNodes`: `false`.
- `MnaModel.findBranchFor`: omitted.
- Class declarations of `poolBacked` and `FLIPFLOP_COMPOSITE_SCHEMA`
  unchanged.

## State pool

Identical to PB-BEHAV-FF-D — composite schema is empty
(`FLIPFLOP_COMPOSITE_SCHEMA`); children own slots; `initChildState` helper
distributes offsets unchanged.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is
spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in `behavioral-flipflop/rs.ts` matches the clocked RS
   block line-for-line.
2. `setup()` body in `behavioral-flipflop/rs-async.ts` matches the
   level-sensitive latch block line-for-line.
3. The level-sensitive latch's setup() body has NO `_clockPin.setup(ctx)`
   call — there is no clock pin model on this class.
4. Forward order is inputs → outputs → children for both.
5. Factory cleanup applied per the "Factory cleanup" section.
6. No `solver.allocElement(...)` calls inside `load()`, `accept()`, or any
   non-`setup()` method on either class.
7. `mayCreateInternalNodes: false` flag set on both `MnaModel` entries.
8. `ngspiceNodeMap` left undefined on both `ComponentDefinition`s.
9. No banned closing verdicts used in any commit message or report.
