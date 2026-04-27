# Task PB-CCCS

**digiTS file:** `src/components/active/cccs.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/cccs/cccsset.c:30-50`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/cccs/cccsload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS pin label | ngspice node suffix | Usage in setup() |
|---|---|---|
| `out+` | `pos` → CCCSposNode | `pinNodes.get("out+")` |
| `out-` | `neg` → CCCSnegNode | `pinNodes.get("out-")` |
| `sense+` | (not used directly) | routed via `senseSourceLabel` |
| `sense-` | (not used directly) | routed via `senseSourceLabel` |

`ngspiceNodeMap: { "out+": "pos", "out-": "neg" }`

The `sense+` / `sense-` pins are wired in the netlist to a virtual zero-volt
VSRC whose label is stored in `senseSourceLabel`. setup() ignores the sense
pin node numbers and calls `ctx.findBranch(senseSourceLabel)` instead, exactly
as ngspice's `CCCSsetup` calls `CKTfndBranch(ckt, here->CCCScontName)`.

**Critical requirement:** `senseSourceLabel` MUST be set on the element via
`setParam("senseSourceLabel", ...)` at compile time, before `setup()` runs.
If `senseSourceLabel` is empty or absent when setup() executes, setup() must
throw: `throw new Error("CCCS '${this.label}': senseSourceLabel not set before setup()")`.
This mirrors ngspice's fatal error at cccsset.c:37-40:
```c
if(here->CCCScontBranch == 0) {
    SPfrontEnd->IFerrorf(ERR_FATAL, "%s: unknown controlling source %s", ...);
    return(E_BADPARM);
}
```

## Internal nodes

None. CCCS has no internal voltage nodes.

## Branch rows

None (own). CCCS does NOT allocate its own branch row.

`hasBranchRow: false`

The controlling branch referenced by `CCCScontBranch` belongs to the controlling
source (a VSRC, IND, VCVS, or CCVS). CCCS only reads that branch column; it does
not allocate it.

## State slots

0. `NG_IGNORE(states)` — cccsset.c performs no `*states +=` increment.

## TSTALLOC sequence (line-for-line port from cccsset.c:49-50)

The TSTALLOC calls come after the `CKTfndBranch` call at line 36. The resolved
controlling branch number is `CCCScontBranch`.

| # | ngspice line | ngspice args | digiTS allocElement args |
|---|---|---|---|
| 1 | `:49` `TSTALLOC(CCCSposContBrptr, CCCSposNode, CCCScontBranch)` | (posNode, contBranch) | `(posNode, contBranch)` |
| 2 | `:50` `TSTALLOC(CCCSnegContBrptr, CCCSnegNode, CCCScontBranch)` | (negNode, contBranch) | `(negNode, contBranch)` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this.pinNodeIds[2]; // pinNodes.get("out+") — CCCSposNode
  const negNode = this.pinNodeIds[3]; // pinNodes.get("out-") — CCCSnegNode

  // Resolve controlling branch: cccsset.c:36
  // ctx.findBranch dispatches to the controlling source's findBranchFor callback
  // (lazy-allocating per 00-engine.md §A2/A4.2). Call order is irrelevant —
  // findBranchFor allocates the branch via ctx.makeCur if setup() hasn't run yet.
  if (!this._senseSourceLabel) {
    throw new Error(`CCCS '${this.label}': senseSourceLabel not set before setup()`);
  }
  const contBranch = ctx.findBranch(this._senseSourceLabel);
  if (contBranch === 0) {
    throw new Error(
      `CCCS '${this.label}': unknown controlling source '${this._senseSourceLabel}'`
    );
  }
  this._contBranch = contBranch;

  // TSTALLOC sequence: cccsset.c:49-50, line-for-line
  this._hPCtBr = solver.allocElement(posNode, contBranch); // :49
  this._hNCtBr = solver.allocElement(negNode, contBranch); // :50
}
```

`pinNodeIds` index ordering matches `buildCCCSPinDeclarations()`:
index 0 = `sense+`, index 1 = `sense-`, index 2 = `out+`, index 3 = `out-`.

Handles `_hPCtBr`, `_hNCtBr` stored on the element instance. `allocElement`
NEVER called from `load()`.

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/cccs/cccsload.c`
line-for-line. No `allocElement`. Stamps the controlled Norton current:

```typescript
load(ctx: LoadContext): void {
  const iSense = ctx.rhsOld[this._contBranch]; // current in controlling branch
  const gm     = this._derivative(iSense);     // f'(I_sense)
  const iNR    = this._value(iSense) - gm * iSense; // NR constant

  ctx.solver.stampElement(this._hPCtBr, -gm); // G[posNode, contBranch]
  ctx.solver.stampElement(this._hNCtBr,  gm); // G[negNode, contBranch]

  ctx.rhs[this.pinNodeIds[2]] += iNR;  // RHS[posNode]
  ctx.rhs[this.pinNodeIds[3]] -= iNR;  // RHS[negNode]
}
```

## findBranchFor (if applicable)

Not applicable. CCCS has no own branch row and registers no `findBranchFor`
callback. It is a consumer of another source's branch, not a provider.

## Sense-source resolution (CCCS, CCVS only)

`senseSourceLabel` is a compile-time property set via `setParam("senseSourceLabel", label)`
during circuit compilation. It identifies the controlling VSRC (or other
branch-owning element) by label.

In setup():
```typescript
const contBranch = ctx.findBranch(this._senseSourceLabel);
```

`ctx.findBranch` dispatches to the controlling source's `findBranchFor` callback
(registered on that source's MnaModel). Per 00-engine.md §A2 and §A4.2, the
`findBranchFor` callback lazily allocates the branch via `ctx.makeCur` if the
controlling source's `setup()` has not yet run. This means CCCS's `setup()` can
call `ctx.findBranch(senseSourceLabel)` regardless of element ordering — the
lazy mechanism ensures the branch number is valid by the time CCCS needs it.

CCCS does NOT wait for the controlling source's setup() to have executed.
The only precondition is that the controlling source is registered in the device
map (populated at compile time, before any setup() runs).

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory (the inline factory in
  `CCCSDefinition.modelRegistry["behavioral"]`). New signature:
  `factory(pinNodes, props, getTime): AnalogElementCore`.
- Drop `branchCount: 1` from MnaModel registration (CCCS has NO own branch row;
  the existing `branchCount: 1` in the current code is wrong — it referred to the
  sense branch which belongs to the controlling VSRC, not to CCCS itself).
- Add `hasBranchRow: false`.
- Add `ngspiceNodeMap: { "out+": "pos", "out-": "neg" }`.
- No `findBranchFor` callback.
- Add `mayCreateInternalNodes: false` (omit — default is false).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-CCCS is GREEN: insertion order must be
   `[(posNode, contBranch), (negNode, contBranch)]` where `contBranch` is the
   branch row number allocated by the controlling VSRC's `findBranchFor`.
2. `src/components/active/__tests__/cccs.test.ts` is GREEN.
3. No banned closing verdicts.
