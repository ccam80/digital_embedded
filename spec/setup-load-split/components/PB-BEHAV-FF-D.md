# Task PB-BEHAV-FF-D

**digiTS files:**
- `src/solver/analog/behavioral-flipflop.ts` (`BehavioralDFlipflopElement` — sync D flip-flop)
- `src/solver/analog/behavioral-flipflop/d-async.ts` (`BehavioralDAsyncFlipflopElement` — D flip-flop with async Set/Clear)

**ngspice anchor:** NONE — behavioral elements. setup() body matches the
existing per-pin-model alloc pattern from `02-behavioral.md` Shape rules
1, 2, 3. NOT bound by ngspice line-for-line equivalence.

This single spec covers BOTH classes. They share the same composite shape
(one composite forwarding to its pin-model array per Shape rule 3); the
only difference is the pin-layout count (4 pins for sync, 6 pins for async).

## Composition (per 02-behavioral.md Shape rule 3)

Both classes have the same composition pattern; counts differ by variant.

| Sub-element type | Count (sync) | Count (async) | Notes |
|---|---|---|---|
| DigitalInputPinModel | 2 | 4 | Sync: D, C. Async: Set, D, C, Clr. |
| DigitalOutputPinModel | 2 | 2 | Q, ~Q (role `"direct"`) for both. |
| AnalogCapacitorElement (child) | dynamic | dynamic | Created by pin model `init` when loaded && cIn/cOut > 0; collected via `buildChildElements`. |

The composite class fields are class-based (post-W2.5 architecture). All
seven flip-flop element classes (D, D-async, JK, JK-async, RS, RS-async,
T) are pool-backed via the unified state pool — `poolBacked = true as
const`, `stateSchema = FLIPFLOP_COMPOSITE_SCHEMA` (empty schema; children
own their slots), `stateSize` aggregated from children, `s0..s7` typed
arrays present per the `ReactiveAnalogElementCore` interface contract.

## Pin layouts

### Sync D flip-flop (`BehavioralDFlipflopElement`)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `D` | 0 | input | Data input |
| `C` | 1 | input | Clock input (rising-edge triggered) |
| `Q` | 2 | output | Output |
| `~Q` | 3 | output | Inverted output |

`pinNodeIds[0..3]` = D, C, Q, ~Q in this order. The composite stores
`_pinNodes: Map<string, number>` with these labels.

### Async D flip-flop (`BehavioralDAsyncFlipflopElement`)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `Set` | 0 | input | Async set (active-high; forces Q=1) |
| `D` | 1 | input | Data input |
| `C` | 2 | input | Clock input |
| `Clr` | 3 | input | Async clear (active-high; forces Q=0) |
| `Q` | 4 | output | Output |
| `~Q` | 5 | output | Inverted output |

## setup() body

### `BehavioralDFlipflopElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model (DigitalInputPinModel.setup per Shape rule 1)
  this._clockPin.setup(ctx);
  this._dPin.setup(ctx);

  // Forward to every output pin model (DigitalOutputPinModel.setup per Shape rule 2, role "direct")
  this._qPin.setup(ctx);
  this._qBarPin.setup(ctx);

  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Note: the existing class also has nullable `_setPin` / `_resetPin` fields
that are always `null` in the sync factory (`makeDFlipflopAnalogFactory`).
The setup() body forwards them conditionally for symmetry — but the sync
factory passes `null`, so the conditional branch is unreachable for
sync-only D flip-flops:

```ts
// (Optional defensive forward — _setPin and _resetPin are null in the
//  sync factory but the field exists on the class.)
if (this._setPin !== null) this._setPin.setup(ctx);
if (this._resetPin !== null) this._resetPin.setup(ctx);
```

Implementer keeps the conditional forwards inside the setup() body so the
class remains agnostic to whether Set/Reset pins are wired (matches the
existing load() body pattern at `behavioral-flipflop.ts:171-172`).

### `BehavioralDAsyncFlipflopElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model
  this._setPin.setup(ctx);
  this._dPin.setup(ctx);
  this._clockPin.setup(ctx);
  this._clrPin.setup(ctx);

  // Forward to every output pin model (role "direct")
  this._qPin.setup(ctx);
  this._qBarPin.setup(ctx);

  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: inputs → outputs → children (per Shape rule 3).

## load() body — value writes only (no allocElement)

The existing `load()` bodies on both classes already stamp through pin
models (which cache handles via `setup()` per Shape rules 1/2). The only
change to load() is removing any residual `_handlesInit` block from the
pin models — the pin model migrations are owned by the `digital-pin-model.ts`
W2.7-style work, not by this PB.

For both classes:
- Inputs delegate stamping to `pin.load(ctx)`.
- Outputs call `pin.setLogicLevel(this._latchedQ)` (or `!this._latchedQ` for
  `~Q`) before `pin.load(ctx)`.
- `_childElements.forEach(child => child.load(ctx))` stamps capacitor
  children through their cached handles.

`accept()` and `getPinCurrents()` are unchanged.

## Pin model TSTALLOC counts (per 02-behavioral.md Shape rules 1, 2)

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)` — `_hNodeDiag`.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)` — `_hNodeDiag`.

| Variant | Input pins | Output pins | TSTALLOC count (before children) |
|---|---|---|---|
| Sync D | 2 | 2 | **4** |
| Async D (with Set/Clr) | 4 | 2 | **6** |

Capacitor children add 4 entries each (per `PB-CAP.md` TSTALLOC sequence).

## Factory cleanup

For each variant's analog factory (`makeDFlipflopAnalogFactory`,
`makeDAsyncFlipflopAnalogFactory`):

- Drop `internalNodeIds` and `branchIdx` from the factory closure signature
  per A6.3 (factory currently ignores them).
- `ComponentDefinition.ngspiceNodeMap` left undefined (behavioral — per
  02-behavioral.md §"Pin-map field on behavioral models").
- `MnaModel.mayCreateInternalNodes`: `false`.
- `MnaModel.findBranchFor`: omitted (no branch row).
- The class continues to declare `poolBacked = true as const` and the
  `stateSchema = FLIPFLOP_COMPOSITE_SCHEMA` empty schema (already present;
  no change required).

## State pool

The composite's own schema is empty (`FLIPFLOP_COMPOSITE_SCHEMA` defined
in `behavioral-flipflop/shared.ts` as `defineStateSchema("BehavioralFlipflopComposite", [])`).
`stateSize` aggregates from `_childElements[].stateSize` via the existing
`computeChildStateSize` helper. `stateBaseOffset` is set by `MNAEngine._setup()`
via `allocateStateBuffers` per `00-engine.md` §A5.1. `initState(pool)`
distributes offsets to children via `initChildState` (existing helper
preserved unchanged).

The composite participates in the unified state pool via `isPoolBacked`
filter at construction in `ckt-context.ts:616`. No new mechanism is
introduced.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is
spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in `behavioral-flipflop.ts` `BehavioralDFlipflopElement`
   matches the sync setup() body block above line-for-line.
2. `setup()` body in `behavioral-flipflop/d-async.ts`
   `BehavioralDAsyncFlipflopElement` matches the async setup() body block
   above line-for-line.
3. Forward order is inputs → outputs → children for both.
4. Factory cleanup applied per the "Factory cleanup" section.
5. No `solver.allocElement(...)` calls inside `load()`, `accept()`, or any
   non-`setup()` method on either class.
6. `mayCreateInternalNodes: false` flag set on both `MnaModel` entries.
7. `ngspiceNodeMap` left undefined on both `ComponentDefinition`s.
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/
   intentional-divergence/citation-divergence/partial) used in any commit
   message or report.
