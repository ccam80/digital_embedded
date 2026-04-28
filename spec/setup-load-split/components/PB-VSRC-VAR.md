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
- Add `ngspiceNodeMap: { pos: "pos" }` (neg is implicit ground — no pin entry).
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
