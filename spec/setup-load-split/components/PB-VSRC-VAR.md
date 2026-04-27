# Task PB-VSRC-VAR

**digiTS file:** `src/components/sources/variable-rail.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/vsrc/vsrcset.c:40-55`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/vsrc/vsrcload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { pos: "pos" }` — `neg` is implicit ground (node 0).

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `pos` | `VSRCposNode` | `"pos"` |
| _(ground)_ | `VSRCnegNode` | hardcoded `0` |

`negNode = 0` always. The variable rail has only one external pin; its negative terminal is permanently wired to ground at the component level.

## Internal nodes

none — `NG_IGNORE(state)` at vsrcset.c:25.

## Branch rows

1 — allocated via `ctx.makeCur(this.label, "branch")`. Idempotent guard replicated in both setup() and `findBranchFor`.

## State slots

0 — `vsrcset.c:25` calls `NG_IGNORE(state)`; no `*states +=` in setup.

## TSTALLOC sequence (line-for-line port)

`vsrcset.c:52-55` — 4 allocations. `negNode = 0` resolves to the ground row/col (which the solver treats as the reference node — stamps into row/col 0 are no-ops by convention, but `allocElement` must still be called to preserve insertion-order parity with ngspice):

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(VSRCposNode, VSRCbranch)` | `(posNode, branchNode)` | `_hPosBr` |
| 2 | `(VSRCnegNode, VSRCbranch)` | `(0, branchNode)` | `_hNegBr` |
| 3 | `(VSRCbranch, VSRCnegNode)` | `(branchNode, 0)` | `_hBrNeg` |
| 4 | `(VSRCbranch, VSRCposNode)` | `(branchNode, posNode)` | `_hBrPos` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const posNode    = this.pinNodes.get("pos")!;
  const negNode    = 0;  // ground — variable rail has no neg pin

  // Port of vsrcset.c:40-43 — idempotent branch allocation
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this.label, "branch");
  }
  const branchNode = this.branchIndex;

  // Port of vsrcset.c:52-55 — TSTALLOC sequence (line-for-line)
  this._hPosBr = ctx.solver.allocElement(posNode,    branchNode); // VSRCposNode, VSRCbranch
  this._hNegBr = ctx.solver.allocElement(negNode,    branchNode); // VSRCnegNode(=0), VSRCbranch
  this._hBrNeg = ctx.solver.allocElement(branchNode, negNode);    // VSRCbranch,  VSRCnegNode(=0)
  this._hBrPos = ctx.solver.allocElement(branchNode, posNode);    // VSRCbranch,  VSRCposNode
}
```

## load() body — value writes only

Implementer ports value-side from `vsrcload.c` line-for-line, stamping through cached handles. No allocElement calls.

The variable rail voltage is set by the user via `setParam("voltage", v)` between steps; load() reads `this._voltage`:
```typescript
// vsrcload.c:43-46
solver.stampElement(this._hPosBr, +1.0);
solver.stampElement(this._hNegBr, -1.0);
solver.stampElement(this._hBrPos, +1.0);
solver.stampElement(this._hBrNeg, -1.0);
// vsrcload.c:416 — RHS (DC value path: MODEDCOP | MODEDCTRANCURVE with dcGiven)
ctx.rhs[this.branchIndex] += this._voltage;
```

## findBranchFor (applicable — VSRC)

```typescript
// Registered on the MnaModel for VariableRail.
// Mirrors VSRCfindBr (vsrc/vsrcfbr.c:26-39).
findBranchFor(name: string, ctx: SetupContext): number {
  if (instance.label === name) {
    if (instance.branchIndex === -1) {
      instance.branchIndex = ctx.makeCur(instance.label, "branch");
    }
    return instance.branchIndex;
  }
  return 0;
}
```

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `hasBranchRow: true`.
- Add `ngspiceNodeMap: { pos: "pos" }` (neg is implicit ground — no pin entry).
- Add `findBranchFor` callback (see above).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-VSRC-VAR is GREEN.
2. `src/components/sources/__tests__/variable-rail.test.ts` is GREEN.
3. No banned closing verdicts.
