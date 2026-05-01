# Task PB-FUSE

> **Spec-doc duplication note (added during remediation-pass-1):** The analog
> `FuseElement` lives in `src/components/passives/analog-fuse.ts` and is owned by
> `PB-AFUSE.md`. `src/components/switching/fuse.ts` is the digital-side
> wrapper- its `FuseDefinition.modelRegistry["behavioral"]` imports
> `createAnalogFuseElement` from `passives/analog-fuse.ts`. There is no separate
> "PB-FUSE" analog implementation. PB-FUSE.md and PB-AFUSE.md describe the same
> setup() / load() bodies. When the W3 owner exercises the analog migration, it
> happens once (in `analog-fuse.ts`) and both specs are satisfied. This file is
> retained for historical traceability; consolidation with PB-AFUSE.md is
> deferred.

**digiTS file:** `src/components/switching/fuse.ts` (digital wrapper) →
delegates analog work to `src/components/passives/analog-fuse.ts` (see
PB-AFUSE.md)
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/res/resload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { out1: "pos", out2: "neg" }` (from the Switching- primitive table in 01-pin-mapping.md)

`FuseElement` is a flat element (not a composite). It owns its conductance handles directly- there is no `ResElement` sub-element.

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `out1` | `RESposNode` | `"out1"` |
| `out2` | `RESnegNode` | `"out2"` |

## Internal nodes

none- RES has no internal nodes. (`NG_IGNORE(state)` and `NG_IGNORE(ckt)` at ressetup.c:22-23 confirm zero state slots.)

## Branch rows

none- RES stamps a conductance, not a branch row.

## State slots

0- `ressetup.c:22-23` calls `NG_IGNORE(state)` and `NG_IGNORE(ckt)`.

## TSTALLOC sequence (line-for-line port)

`ressetup.c:46-49`- 4 allocations, in order, on `FuseElement` directly:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(posNode, posNode)` | `_hPP` |
| 2 | `(RESnegNode, RESnegNode)` | `(negNode, negNode)` | `_hNN` |
| 3 | `(RESposNode, RESnegNode)` | `(posNode, negNode)` | `_hPN` |
| 4 | `(RESnegNode, RESposNode)` | `(negNode, posNode)` | `_hNP` |

## setup() body- alloc only

```typescript
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this._pinNodes.get("out1")!;  // RESposNode
  const negNode = this._pinNodes.get("out2")!;  // RESnegNode

  // Port of ressetup.c:46-49- TSTALLOC sequence (line-for-line)
  this._hPP = solver.allocElement(posNode, posNode);  // (RESposNode, RESposNode)
  this._hNN = solver.allocElement(negNode, negNode);  // (RESnegNode, RESnegNode)
  this._hPN = solver.allocElement(posNode, negNode);  // (RESposNode, RESnegNode)
  this._hNP = solver.allocElement(negNode, posNode);  // (RESnegNode, RESposNode)
}
```

Fields to add to `FuseElement`:
```typescript
private _hPP: number = -1;
private _hNN: number = -1;
private _hPN: number = -1;
private _hNP: number = -1;
private _conduct: number = 1;  // = 1/R, updated by accept()
```

## load() body- value writes only

Implementer ports value-side from `resload.c` line-for-line, stamping through cached handles. No allocElement calls.

```typescript
load(ctx: LoadContext): void {
  const g = this._conduct;  // = 1/R, updated by accept()
  ctx.solver.stampElement(this._hPP, +g);
  ctx.solver.stampElement(this._hNN, +g);
  ctx.solver.stampElement(this._hPN, -g);
  ctx.solver.stampElement(this._hNP, -g);
}
```

The `accept()` body reads current from `(ctx.rhs[posNode] - ctx.rhs[negNode]) * g` for the blow check, then recomputes resistance:

```typescript
accept(ctx: AcceptContext): void {
  const posNode = this._pinNodes.get("out1")!;
  const negNode = this._pinNodes.get("out2")!;
  const v = ctx.rhs[posNode] - ctx.rhs[negNode];
  const i = v * this._conduct;
  this._i2tAccum += i * i * ctx.dt;
  const newR = computeFuseResistance(this._i2tAccum, this._params);
  this._conduct = 1 / newR;
}
```

## findBranchFor (not applicable)

RES has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `ngspiceNodeMap: { out1: "pos", out2: "neg" }` to `FuseElement`'s `ComponentDefinition` directly (flat element, no sub-element).
- No `findBranchFor` callback.
- Remove all references to `ResElement` as a sub-element- `FuseElement` is now flat and owns its own handles.

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
