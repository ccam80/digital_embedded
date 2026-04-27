# Task PB-VSRC-AC

**digiTS file:** `src/components/sources/ac-voltage-source.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/vsrc/vsrcset.c:40-55`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/vsrc/vsrcload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { neg: "neg", pos: "pos" }`

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `neg` | `VSRCnegNode` | `"neg"` |
| `pos` | `VSRCposNode` | `"pos"` |

## Internal nodes

none — same as DC voltage source. `NG_IGNORE(state)` at vsrcset.c:25.

## Branch rows

1 — allocated via `ctx.makeCur(this.label, "branch")`. Idempotent guard (`if (here->VSRCbranch == 0)`) replicated in both setup() and `findBranchFor`.

## State slots

0 — `vsrcset.c:25` calls `NG_IGNORE(state)`; no `*states +=` in setup.

## TSTALLOC sequence (line-for-line port)

`vsrcset.c:52-55` — 4 allocations, identical order to PB-VSRC-DC:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(VSRCposNode, VSRCbranch)` | `(posNode, branchNode)` | `_hPosBr` |
| 2 | `(VSRCnegNode, VSRCbranch)` | `(negNode, branchNode)` | `_hNegBr` |
| 3 | `(VSRCbranch, VSRCnegNode)` | `(branchNode, negNode)` | `_hBrNeg` |
| 4 | `(VSRCbranch, VSRCposNode)` | `(branchNode, posNode)` | `_hBrPos` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const posNode    = this.pinNodes.get("pos")!;
  const negNode    = this.pinNodes.get("neg")!;

  // Port of vsrcset.c:40-43 — idempotent branch allocation
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this.label, "branch");
  }
  const branchNode = this.branchIndex;

  // Port of vsrcset.c:52-55 — TSTALLOC sequence (line-for-line)
  this._hPosBr = ctx.solver.allocElement(posNode,    branchNode); // VSRCposNode, VSRCbranch
  this._hNegBr = ctx.solver.allocElement(negNode,    branchNode); // VSRCnegNode, VSRCbranch
  this._hBrNeg = ctx.solver.allocElement(branchNode, negNode);    // VSRCbranch,  VSRCnegNode
  this._hBrPos = ctx.solver.allocElement(branchNode, posNode);    // VSRCbranch,  VSRCposNode
}
```

## load() body — value writes only

Implementer ports value-side from `vsrcload.c` line-for-line, stamping through cached handles. No allocElement calls.

AC voltage source computes its value using the SINE waveform case (vsrcload.c:130-168) or the DC value during DC operating point. Key stamps identical to PB-VSRC-DC:
```typescript
// vsrcload.c:43-46
solver.stampElement(this._hPosBr, +1.0);
solver.stampElement(this._hNegBr, -1.0);
solver.stampElement(this._hBrPos, +1.0);
solver.stampElement(this._hBrNeg, -1.0);
// vsrcload.c:416 — RHS
ctx.rhs[this.branchIndex] += value;  // AC sine value or DC offset
```

## findBranchFor (applicable — VSRC)

```typescript
// Registered on the MnaModel for AcVoltageSource.
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
- Add `ngspiceNodeMap: { neg: "neg", pos: "pos" }`.
- Add `findBranchFor` callback (see above).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-VSRC-AC is GREEN.
2. `src/components/sources/__tests__/ac-voltage-source.test.ts` is GREEN.
3. No banned closing verdicts.
