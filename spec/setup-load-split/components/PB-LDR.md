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

None (branchIndex remains -1 post-setup).

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
  const posNode = this._pinNodes.get("pos")!; // RESposNode
  const negNode = this._pinNodes.get("neg")!; // RESnegNode

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
- Add `ngspiceNodeMap: { pos: "pos", neg: "neg" }` to the `behavioral` model
  registration and to `LDRDefinition`.
- No `findBranchFor` callback.

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
