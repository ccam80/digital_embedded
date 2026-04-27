# Task PB-LDR

**digiTS file:** `src/components/sensors/ldr.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/res/resload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS pin label | ngspice node suffix | Usage in setup() |
|---|---|---|
| `pos` | `pos` → RESposNode | `pinNodes.get("pos")` |
| `neg` | `neg` → RESnegNode | `pinNodes.get("neg")` |

`ngspiceNodeMap: { pos: "pos", neg: "neg" }`

LDR is a composite wrapping a single variable RES sub-element. The composite's
own `ngspiceNodeMap` is undefined; only the RES sub-element carries the map above.
However, because LDR is currently a single flat element (not a composite with an
actual RES child), its setup() body acts as the RES setup directly.

## Internal nodes

None. RES has no internal nodes.

## Branch rows

None. `hasBranchRow: false`.

## State slots

0. `NG_IGNORE(state)` — RESsetup performs no `*state +=` increment.

## TSTALLOC sequence (line-for-line port from ressetup.c:46-49)

| # | ngspice line | ngspice args | digiTS allocElement args |
|---|---|---|---|
| 1 | `:46` `TSTALLOC(RESposPosptr, RESposNode, RESposNode)` | (posNode, posNode) | `(posNode, posNode)` |
| 2 | `:47` `TSTALLOC(RESnegNegptr, RESnegNode, RESnegNode)` | (negNode, negNode) | `(negNode, negNode)` |
| 3 | `:48` `TSTALLOC(RESposNegptr, RESposNode, RESnegNode)` | (posNode, negNode) | `(posNode, negNode)` |
| 4 | `:49` `TSTALLOC(RESnegPosptr, RESnegNode, RESposNode)` | (negNode, posNode) | `(negNode, posNode)` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this.pinNodeIds[0]; // pinNodes.get("pos") — RESposNode
  const negNode = this.pinNodeIds[1]; // pinNodes.get("neg") — RESnegNode

  // TSTALLOC sequence: ressetup.c:46-49, line-for-line
  this._hPP = solver.allocElement(posNode, posNode); // :46 (RESposNode, RESposNode)
  this._hNN = solver.allocElement(negNode, negNode); // :47 (RESnegNode, RESnegNode)
  this._hPN = solver.allocElement(posNode, negNode); // :48 (RESposNode, RESnegNode)
  this._hNP = solver.allocElement(negNode, posNode); // :49 (RESnegNode, RESposNode)
}
```

Handles `_hPP`, `_hNN`, `_hPN`, `_hNP` are stored on the element instance.
`allocElement` is NEVER called from `load()`.

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/res/resload.c`
line-for-line. No `allocElement`. Writes:

```typescript
load(ctx: LoadContext): void {
  const G = 1 / Math.max(this.resistance(), MIN_RESISTANCE);
  ctx.solver.stampElement(this._hPP,  G);
  ctx.solver.stampElement(this._hNN,  G);
  ctx.solver.stampElement(this._hPN, -G);
  ctx.solver.stampElement(this._hNP, -G);
}
```

The `resistance()` method uses current lux and model parameters. The `accept()`
hook updates lux from a property (the `lux` setParam). Temperature-driven
variants belong to NTC — LDR's resistance is lux-driven only.

## findBranchFor (if applicable)

Not applicable. LDR has no branch row.

## Sense-source resolution (CCCS, CCVS only)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory (`createLDRElement`).
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `hasBranchRow: false`.
- Add `ngspiceNodeMap: { pos: "pos", neg: "neg" }` to the `behavioral` model
  registration and to `LDRDefinition`.
- No `findBranchFor` callback.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-LDR is GREEN: insertion order
   must be `[(posNode,posNode), (negNode,negNode), (posNode,negNode), (negNode,posNode)]`.
2. `src/components/sensors/__tests__/ldr.test.ts` is GREEN.
3. No banned closing verdicts.
