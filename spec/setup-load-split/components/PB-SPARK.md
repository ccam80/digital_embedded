# Task PB-SPARK

**digiTS file:** `src/components/sensors/spark-gap.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS pin label | ngspice node suffix | Usage in setup() |
|---|---|---|
| `pos` | `pos` → SWposNode | `pinNodes.get("pos")` |
| `neg` | `neg` → SWnegNode | `pinNodes.get("neg")` |

`ngspiceNodeMap: { pos: "pos", neg: "neg" }`

SparkGap is a composite wrapping a single SW sub-element. The composite's
own `ngspiceNodeMap` is undefined; only the SW sub-element carries the map above.
Because the current implementation is a single flat element, its setup() body
acts as the SW setup directly.

## Internal nodes

None. SW has no internal nodes.

## Branch rows

None (branchIndex remains -1 post-setup).

## State slots

`swsetup.c:47-48`:
```c
here->SWstate = *states;
*states += SW_NUM_STATES;   // SW_NUM_STATES = 2 per swdefs.h:56
```

In setup():
```typescript
this._stateBase = ctx.allocStates(2); // SW_NUM_STATES = 2
```

## TSTALLOC sequence (line-for-line port from swsetup.c:59-62)

| # | ngspice line | ngspice args | digiTS allocElement args |
|---|---|---|---|
| 1 | `:59` `TSTALLOC(SWposPosptr, SWposNode, SWposNode)` | (posNode, posNode) | `(posNode, posNode)` |
| 2 | `:60` `TSTALLOC(SWposNegptr, SWposNode, SWnegNode)` | (posNode, negNode) | `(posNode, negNode)` |
| 3 | `:61` `TSTALLOC(SWnegPosptr, SWnegNode, SWposNode)` | (negNode, posNode) | `(negNode, posNode)` |
| 4 | `:62` `TSTALLOC(SWnegNegptr, SWnegNode, SWnegNode)` | (negNode, negNode) | `(negNode, negNode)` |

Note: SW's TSTALLOC ordering differs from RES. SW stamps the cross terms
(posNode, negNode) and (negNode, posNode) before the (negNode, negNode) diagonal,
whereas RES stamps all four in PP, NN, PN, NP order.

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this.pinNodeIds[0]; // pinNodes.get("pos") — SWposNode
  const negNode = this.pinNodeIds[1]; // pinNodes.get("neg") — SWnegNode

  // State allocation: swsetup.c:47-48
  this._stateBase = ctx.allocStates(2); // SW_NUM_STATES = 2 (swdefs.h:56)

  // TSTALLOC sequence: swsetup.c:59-62, line-for-line
  this._hPP = solver.allocElement(posNode, posNode); // :59 (SWposNode, SWposNode)
  this._hPN = solver.allocElement(posNode, negNode); // :60 (SWposNode, SWnegNode)
  this._hNP = solver.allocElement(negNode, posNode); // :61 (SWnegNode, SWposNode)
  this._hNN = solver.allocElement(negNode, negNode); // :62 (SWnegNode, SWnegNode)
}
```

Handles `_hPP`, `_hPN`, `_hNP`, `_hNN` stored on instance. `_stateBase` stores
the state slot base returned by `allocStates`. `allocElement` is NEVER called from
`load()`.

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/sw/swload.c`
line-for-line. No `allocElement`.

The ignition condition (|V| > vBreakdown) and extinction condition (|I| < iHold)
live entirely in `load()` / `accept()`. The composite's `load()` evaluates the
current terminal voltage from `ctx.rhsOld`, determines the conducting state, and
stamps the appropriate conductance:

```typescript
load(ctx: LoadContext): void {
  const G = 1 / Math.max(this.resistance(), MIN_RESISTANCE);
  ctx.solver.stampElement(this._hPP,  G);
  ctx.solver.stampElement(this._hPN, -G);
  ctx.solver.stampElement(this._hNP, -G);
  ctx.solver.stampElement(this._hNN,  G);
}
```

The `resistance()` method computes the smooth tanh-blended resistance based on
`_conducting` state and `_vTerminal` (updated each `accept()` call).

State slots: ngspice uses `SWstate` to store the on/off state across NR
iterations; digiTS maps this to `_stateBase + 0` (current state) and
`_stateBase + 1` (previous state) within the StatePool. The `accept()` method
writes the accepted discrete state into the pool; `load()` reads it back.

## findBranchFor (if applicable)

Not applicable. SparkGap has no branch row.

## Sense-source resolution (CCCS, CCVS only)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory (`createSparkGapElement`).
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `ngspiceNodeMap: { pos: "pos", neg: "neg" }` to the `behavioral` model
  registration and to `SparkGapDefinition`.
- No `findBranchFor` callback.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-SPARK is GREEN: insertion order
   must be `[(posNode,posNode), (posNode,negNode), (negNode,posNode), (negNode,negNode)]`.
2. `src/components/sensors/__tests__/spark-gap.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
