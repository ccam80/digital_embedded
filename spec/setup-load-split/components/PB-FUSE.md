# Task PB-FUSE

**digiTS file:** `src/components/switching/fuse.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/res/resload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { out1: "pos", out2: "neg" }` (from the Switching — primitive table in 01-pin-mapping.md)

Fuse is a composite that decomposes to a single variable-resistance RES sub-element. The composite has no `ngspiceNodeMap` of its own; the RES sub-element carries the map.

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `out1` | `RESposNode` | `"out1"` |
| `out2` | `RESnegNode` | `"out2"` |

## Internal nodes

none — RES has no internal nodes. (`NG_IGNORE(state)` and `NG_IGNORE(ckt)` at ressetup.c:22-23 confirm zero state slots.)

## Branch rows

none — RES stamps a conductance, not a branch row.

## State slots

0 — `ressetup.c:22-23` calls `NG_IGNORE(state)` and `NG_IGNORE(ckt)`.

## TSTALLOC sequence (line-for-line port)

`ressetup.c:46-49` — 4 allocations, in order:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(posNode, posNode)` | `res._hPP` |
| 2 | `(RESnegNode, RESnegNode)` | `(negNode, negNode)` | `res._hNN` |
| 3 | `(RESposNode, RESnegNode)` | `(posNode, negNode)` | `res._hPN` |
| 4 | `(RESnegNode, RESposNode)` | `(negNode, posNode)` | `res._hNP` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  // Fuse composite forwards directly to its single RES sub-element.
  this._res.setup(ctx);
}
```

The RES sub-element's setup() body:
```typescript
// Inside ResElement.setup():
setup(ctx: SetupContext): void {
  const posNode = this.pinNodes.get("out1")!;
  const negNode = this.pinNodes.get("out2")!;

  // Port of ressetup.c:46-49 — TSTALLOC sequence (line-for-line)
  this._hPP = ctx.solver.allocElement(posNode, posNode); // RESposNode, RESposNode
  this._hNN = ctx.solver.allocElement(negNode, negNode); // RESnegNode, RESnegNode
  this._hPN = ctx.solver.allocElement(posNode, negNode); // RESposNode, RESnegNode
  this._hNP = ctx.solver.allocElement(negNode, posNode); // RESnegNode, RESposNode
}
```

## load() body — value writes only

Implementer ports value-side from `resload.c` line-for-line, stamping through cached handles. No allocElement calls.

The fuse resistance `R` is updated each accepted timestep by the composite's `accept()` method based on the I²t integral. The RES sub-element's `setParam("R", newR)` updates `RESconduct = 1/R` before the next load() call.

Key stamps (resload.c:34-37):
```typescript
// resload.c:34-37
const g = this._res.conduct;  // = 1/R, updated by accept()
solver.stampElement(this._res._hPP, +g);
solver.stampElement(this._res._hNN, +g);
solver.stampElement(this._res._hPN, -g);
solver.stampElement(this._res._hNP, -g);
```

The `accept()` body on the composite (called by the engine after each accepted timestep):
```typescript
accept(ctx: AcceptContext): void {
  const iSquared = this._res.current ** 2;
  this._i2tAccum += iSquared * ctx.dt;
  const newR = computeFuseResistance(this._i2tAccum, this._params);
  this._res.setParam("R", newR);
}
```

## findBranchFor (not applicable)

RES has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `hasBranchRow: false`.
- Add `ngspiceNodeMap: { out1: "pos", out2: "neg" }` on the RES sub-element registration.
- No `findBranchFor` callback.
- Composite carries `{ _res: ResElement }` as a direct ref.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-FUSE is GREEN (4-entry sequence matching ressetup.c:46-49).
2. `src/components/switching/__tests__/fuse.test.ts` is GREEN.
3. No banned closing verdicts.
