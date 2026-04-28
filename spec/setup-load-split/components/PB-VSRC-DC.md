# Task PB-VSRC-DC

**digiTS file:** `src/components/sources/dc-voltage-source.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/vsrc/vsrcset.c:40-55`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/vsrc/vsrcload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { neg: "neg", pos: "pos" }`

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `neg` | `VSRCnegNode` | `"neg"` |
| `pos` | `VSRCposNode` | `"pos"` |

## Internal nodes

none — VSRC has no internal voltage nodes. (`NG_IGNORE(state)` at vsrcset.c:25 confirms zero state slots.)

## Branch rows

1 — allocated via `ctx.makeCur(this.label, "branch")`. The idempotent guard (`if (here->VSRCbranch == 0)`) is replicated in setup() and in `findBranchFor` so call order is irrelevant.

## State slots

0 — `vsrcset.c:25` calls `NG_IGNORE(state)`; no `*states +=` anywhere in the setup function.

## TSTALLOC sequence (line-for-line port)

`vsrcset.c:52-55` — 4 allocations, in order:

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

Key load stamps (vsrcload.c:43-46 matrix stamps, :416 RHS stamp):
```typescript
// vsrcload.c:43-46
solver.stampElement(this._hPosBr, +1.0);
solver.stampElement(this._hNegBr, -1.0);
solver.stampElement(this._hBrPos, +1.0);
solver.stampElement(this._hBrNeg, -1.0);
// vsrcload.c:416 — RHS
ctx.rhs[this.branchIndex] += value;  // computed DC or waveform value
```

## findBranchFor (applicable — VSRC)

```typescript
// Registered on the MnaModel for DcVoltageSource.
// Mirrors VSRCfindBr (vsrc/vsrcfbr.c:26-39).
findBranchFor(name: string, ctx: SetupContext): number {
  // Look up the device by namespaced label (auto-registered per 00-engine.md §A4.1 recursive _deviceMap walk).
  const el = ctx.findDevice(name);
  if (!el) return 0;
  // The element owns its branch row. Lazy-allocate if needed.
  if (el.branchIndex === -1) {
    el.branchIndex = ctx.makeCur(name, "branch");
  }
  return el.branchIndex;
}
```

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `mayCreateInternalNodes: false` (omit — default).
- Add `ngspiceNodeMap: { neg: "neg", pos: "pos" }`.
- Add `findBranchFor` callback (see above).

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
