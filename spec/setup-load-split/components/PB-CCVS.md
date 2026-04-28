# Task PB-CCVS

**digiTS file:** `src/components/active/ccvs.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/ccvs/ccvsset.c:40-62`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/ccvs/ccvsload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS pin label | ngspice node suffix | Usage in setup() |
|---|---|---|
| `out+` | `pos` → CCVSposNode | `pinNodes.get("out+")` |
| `out-` | `neg` → CCVSnegNode | `pinNodes.get("out-")` |
| `sense+` | (not used directly) | routed via `senseSourceLabel` |
| `sense-` | (not used directly) | routed via `senseSourceLabel` |

`ngspiceNodeMap: { "out+": "pos", "out-": "neg" }`

The `sense+` / `sense-` pins are wired in the netlist to a virtual zero-volt
VSRC whose label is stored in `senseSourceLabel`. setup() ignores the sense
pin node numbers and calls `ctx.findBranch(senseSourceLabel)` instead, exactly
as ngspice's `CCVSsetup` calls `CKTfndBranch(ckt, here->CCVScontName)`.

**Critical requirement:** `senseSourceLabel` MUST be set on the element via
`setParam("senseSourceLabel", ...)` at compile time, before `setup()` runs.
If `senseSourceLabel` is empty or absent when setup() executes, setup() must
throw: `throw new Error("CCVS '${this.label}': senseSourceLabel not set before setup()")`.
This mirrors ngspice's fatal error at ccvsset.c:46-49:
```c
if(here->CCVScontBranch == 0) {
    SPfrontEnd->IFerrorf(ERR_FATAL, "%s: unknown controlling source %s", ...);
    return(E_BADPARM);
}
```

## Internal nodes

None. CCVS has no internal voltage nodes.

## Branch rows

1 own branch row — the output voltage source current branch.

Branch allocated via `ctx.makeCur(this.label, "branch")`, mirroring ccvsset.c:40-43:
```c
if(here->CCVSbranch==0) {
    error = CKTmkCur(ckt, &tmp, here->CCVSname, "branch");
    here->CCVSbranch = tmp->number;
}
```

The controlling branch (`CCVScontBranch`) is resolved separately via
`ctx.findBranch(senseSourceLabel)` — this is the branch of the controlling VSRC
(or other branch-owning source), not CCVS's own branch.

## State slots

0. `NG_IGNORE(states)` — ccvsset.c performs no `*states +=` increment.

## TSTALLOC sequence (line-for-line port from ccvsset.c:58-62)

The TSTALLOC calls come after both `CKTmkCur` (line 40-43) and `CKTfndBranch`
(line 45) have resolved `CCVSbranch` and `CCVScontBranch`.

| # | ngspice line | ngspice args | digiTS allocElement args |
|---|---|---|---|
| 1 | `:58` `TSTALLOC(CCVSposIbrptr, CCVSposNode, CCVSbranch)` | (posNode, ownBranch) | `(posNode, ownBranch)` |
| 2 | `:59` `TSTALLOC(CCVSnegIbrptr, CCVSnegNode, CCVSbranch)` | (negNode, ownBranch) | `(negNode, ownBranch)` |
| 3 | `:60` `TSTALLOC(CCVSibrNegptr, CCVSbranch, CCVSnegNode)` | (ownBranch, negNode) | `(ownBranch, negNode)` |
| 4 | `:61` `TSTALLOC(CCVSibrPosptr, CCVSbranch, CCVSposNode)` | (ownBranch, posNode) | `(ownBranch, posNode)` |
| 5 | `:62` `TSTALLOC(CCVSibrContBrptr, CCVSbranch, CCVScontBranch)` | (ownBranch, contBranch) | `(ownBranch, contBranch)` |

Note: entries 3 and 4 are in negNode-then-posNode order (`ibrNeg` before
`ibrPos`) — this is the exact ngspice ordering from ccvsset.c:60-61 and must be
preserved exactly for `setup-stamp-order.test.ts` to pass.

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this.pinNodeIds[2]; // pinNodes.get("out+") — CCVSposNode
  const negNode = this.pinNodeIds[3]; // pinNodes.get("out-") — CCVSnegNode

  // Own branch row: ccvsset.c:58-62 (idempotent guard)
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this.label, "branch");
  }
  const ownBranch = this.branchIndex;

  // Resolve controlling branch: ccvsset.c:45
  // ctx.findBranch dispatches to the controlling source's findBranchFor callback
  // (lazy-allocating per 00-engine.md §A2/A4.2). Call order is irrelevant —
  // findBranchFor allocates the branch via ctx.makeCur if the controlling
  // source's setup() has not yet run.
  if (!this._senseSourceLabel) {
    throw new Error(`CCVS '${this.label}': senseSourceLabel not set before setup()`);
  }
  const contBranch = ctx.findBranch(this._senseSourceLabel);
  if (contBranch === 0) {
    throw new Error(
      `CCVS '${this.label}': unknown controlling source '${this._senseSourceLabel}'`
    );
  }
  this._contBranch = contBranch;

  // TSTALLOC sequence: ccvsset.c:58-62, line-for-line
  this._hPIbr      = solver.allocElement(posNode,   ownBranch);  // :58
  this._hNIbr      = solver.allocElement(negNode,   ownBranch);  // :59
  this._hIbrN      = solver.allocElement(ownBranch, negNode);    // :60
  this._hIbrP      = solver.allocElement(ownBranch, posNode);    // :61
  this._hIbrCtBr   = solver.allocElement(ownBranch, contBranch); // :62
}
```

`pinNodeIds` index ordering matches `buildCCVSPinDeclarations()`:
index 0 = `sense+`, index 1 = `sense-`, index 2 = `out+`, index 3 = `out-`.

All 5 handles stored on the element instance. `allocElement` NEVER called from
`load()`.

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/ccvs/ccvsload.c`
line-for-line. No `allocElement`. Stamps the output voltage source and the
Jacobian entry linking it to the controlling branch:

```typescript
load(ctx: LoadContext): void {
  const iSense = ctx.rhsOld[this._contBranch]; // controlling branch current
  const rm     = this._derivative(iSense);     // f'(I_sense) — transresistance for linear case
  const vNR    = this._value(iSense) - rm * iSense; // NR constant term

  // B/C incidence for own output voltage source branch
  ctx.solver.stampElement(this._hPIbr,    1);   // B[posNode, ownBranch]
  ctx.solver.stampElement(this._hNIbr,   -1);   // B[negNode, ownBranch]
  ctx.solver.stampElement(this._hIbrN,   -1);   // C[ownBranch, negNode]
  ctx.solver.stampElement(this._hIbrP,    1);   // C[ownBranch, posNode]

  // Jacobian: link output branch equation to controlling branch variable
  ctx.solver.stampElement(this._hIbrCtBr, -rm); // C[ownBranch, contBranch]

  // NR-linearized RHS for the output branch equation
  ctx.rhs[this.branchIndex] += vNR;
}
```

## findBranchFor

CCVS must register a `findBranchFor` callback on its MnaModel so that any
downstream CCCS/CCVS that senses the CCVS output current can lazily resolve it.
Mirrors VSRCfindBr (`vsrc/vsrcfbr.c:26-39`):

```typescript
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

This callback is attached to the `behavioral` MnaModel entry.

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
controlling source's `setup()` has not yet run. This means CCVS's `setup()` can
call `ctx.findBranch(senseSourceLabel)` regardless of element ordering — the
lazy mechanism ensures the branch number is valid by the time CCVS needs it.

CCVS does NOT wait for the controlling source's setup() to have executed.
The only precondition is that the controlling source is registered in the device
map (populated at compile time, before any setup() runs).

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory (the inline factory in
  `CCVSDefinition.modelRegistry["behavioral"]`). New signature:
  `factory(pinNodes, props, getTime): AnalogElementCore`.
- Drop `branchCount: 2` from MnaModel registration (CCVS now has 1 own branch
  row only; the old second branch was the sense branch which belongs to the
  controlling VSRC).
- Add `ngspiceNodeMap: { "out+": "pos", "out-": "neg" }`.
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
