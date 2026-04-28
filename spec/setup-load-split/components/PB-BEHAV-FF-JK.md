# Task PB-BEHAV-FF-JK

**digiTS files:**
- `src/solver/analog/behavioral-flipflop/jk.ts` (`BehavioralJKFlipflopElement` — sync JK flip-flop)
- `src/solver/analog/behavioral-flipflop/jk-async.ts` (`BehavioralJKAsyncFlipflopElement` — JK flip-flop with async Set/Clear)

**ngspice anchor:** NONE — behavioral elements. setup() body matches the
existing per-pin-model alloc pattern from `02-behavioral.md` Shape rules
1, 2, 3. NOT bound by ngspice line-for-line equivalence.

This single spec covers BOTH classes. Same composite shape as PB-BEHAV-FF-D;
pin layouts differ.

## Composition (per 02-behavioral.md Shape rule 3)

| Sub-element type | Count (sync) | Count (async) | Notes |
|---|---|---|---|
| DigitalInputPinModel | 3 | 5 | Sync: J, C, K. Async: Set, J, C, K, Clr. |
| DigitalOutputPinModel | 2 | 2 | Q, ~Q (role `"direct"`) for both. |
| AnalogCapacitorElement (child) | dynamic | dynamic | Created by pin model `init` when loaded && cIn/cOut > 0. |

Class-based (post-W2.5). Pool-backed via `FLIPFLOP_COMPOSITE_SCHEMA`
(empty), children own slots.

## Pin layouts

### Sync JK flip-flop (`BehavioralJKFlipflopElement`)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `J` | 0 | input | J input |
| `C` | 1 | input | Clock |
| `K` | 2 | input | K input |
| `Q` | 3 | output | Output |
| `~Q` | 4 | output | Inverted output |

### Async JK flip-flop (`BehavioralJKAsyncFlipflopElement`)

| Pin label | Index | Direction | Notes |
|---|---|---|---|
| `Set` | 0 | input | Async set (active-high) |
| `J` | 1 | input | J input |
| `C` | 2 | input | Clock |
| `K` | 3 | input | K input |
| `Clr` | 4 | input | Async clear (active-high) |
| `Q` | 5 | output | Output |
| `~Q` | 6 | output | Inverted output |

## setup() body

### `BehavioralJKFlipflopElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model
  this._jPin.setup(ctx);
  this._clockPin.setup(ctx);
  this._kPin.setup(ctx);

  // Forward to every output pin model (role "direct")
  this._qPin.setup(ctx);
  this._qBarPin.setup(ctx);

  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

### `BehavioralJKAsyncFlipflopElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model
  this._setPin.setup(ctx);
  this._jPin.setup(ctx);
  this._clockPin.setup(ctx);
  this._kPin.setup(ctx);
  this._clrPin.setup(ctx);

  // Forward to every output pin model (role "direct")
  this._qPin.setup(ctx);
  this._qBarPin.setup(ctx);

  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
}
```

Forward order: inputs → outputs → children (per Shape rule 3).

## load() body — value writes only

The existing `load()` bodies on both classes stamp through pin models
(which cache handles via `setup()` per Shape rules 1/2). No `solver.allocElement`
calls remain after pin-model migration. `accept()` and `getPinCurrents()`
are unchanged.

## Pin model TSTALLOC counts

Per `DigitalInputPinModel` (when loaded): 1 × `(node, node)`.
Per `DigitalOutputPinModel` role `"direct"`: 1 × `(node, node)`.

| Variant | Input pins | Output pins | TSTALLOC count (before children) |
|---|---|---|---|
| Sync JK | 3 | 2 | **5** |
| Async JK | 5 | 2 | **7** |

Capacitor children add 4 entries each (per `PB-CAP.md`).

## Factory cleanup

For each variant's analog factory (`makeJKFlipflopAnalogFactory`,
`makeJKAsyncFlipflopAnalogFactory`):

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

1. `setup()` body in `behavioral-flipflop/jk.ts` matches the sync block
   line-for-line.
2. `setup()` body in `behavioral-flipflop/jk-async.ts` matches the async
   block line-for-line.
3. Forward order is inputs → outputs → children for both.
4. Factory cleanup applied per the "Factory cleanup" section.
5. No `solver.allocElement(...)` calls inside `load()`, `accept()`, or any
   non-`setup()` method on either class.
6. `mayCreateInternalNodes: false` flag set on both `MnaModel` entries.
7. `ngspiceNodeMap` left undefined on both `ComponentDefinition`s.
8. No banned closing verdicts used in any commit message or report.
