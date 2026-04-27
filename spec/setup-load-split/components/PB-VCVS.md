# Task PB-VCVS

**digiTS file:** `src/components/active/vcvs.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/vcvs/vcvsset.c:53-58`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/vcvs/vcvsload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS pin label | ngspice node suffix | Usage in setup() |
|---|---|---|
| `out+` | `pos` → VCVSposNode | `pinNodes.get("out+")` |
| `out-` | `neg` → VCVSnegNode | `pinNodes.get("out-")` |
| `ctrl+` | `contPos` → VCVScontPosNode | `pinNodes.get("ctrl+")` |
| `ctrl-` | `contNeg` → VCVScontNegNode | `pinNodes.get("ctrl-")` |

`ngspiceNodeMap: { "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }`

## Internal nodes

None. VCVS has no internal voltage nodes.

## Branch rows

1 branch row — the output current branch.

Allocated via `ctx.makeCur(this.label, "branch")`, mirroring vcvsset.c:41-44:
```c
if(here->VCVSbranch == 0) {
    error = CKTmkCur(ckt, &tmp, here->VCVSname, "branch");
    here->VCVSbranch = tmp->number;
}
```

## State slots

0. `NG_IGNORE(states)` — vcvsset.c performs no `*states +=` increment.

## TSTALLOC sequence (line-for-line port from vcvsset.c:53-58)

| # | ngspice line | ngspice args | digiTS allocElement args |
|---|---|---|---|
| 1 | `:53` `TSTALLOC(VCVSposIbrptr, VCVSposNode, VCVSbranch)` | (posNode, branch) | `(posNode, branch)` |
| 2 | `:54` `TSTALLOC(VCVSnegIbrptr, VCVSnegNode, VCVSbranch)` | (negNode, branch) | `(negNode, branch)` |
| 3 | `:55` `TSTALLOC(VCVSibrPosptr, VCVSbranch, VCVSposNode)` | (branch, posNode) | `(branch, posNode)` |
| 4 | `:56` `TSTALLOC(VCVSibrNegptr, VCVSbranch, VCVSnegNode)` | (branch, negNode) | `(branch, negNode)` |
| 5 | `:57` `TSTALLOC(VCVSibrContPosptr, VCVSbranch, VCVScontPosNode)` | (branch, contPosNode) | `(branch, ctrlPosNode)` |
| 6 | `:58` `TSTALLOC(VCVSibrContNegptr, VCVSbranch, VCVScontNegNode)` | (branch, contNegNode) | `(branch, ctrlNegNode)` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode     = this.pinNodeIds[2]; // pinNodes.get("out+")  — VCVSposNode
  const negNode     = this.pinNodeIds[3]; // pinNodes.get("out-")  — VCVSnegNode
  const ctrlPosNode = this.pinNodeIds[0]; // pinNodes.get("ctrl+") — VCVScontPosNode
  const ctrlNegNode = this.pinNodeIds[1]; // pinNodes.get("ctrl-") — VCVScontNegNode

  // Branch row allocation: vcvsset.c:41-44 (idempotent guard — vcvsset.c:41-44)
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this.label, "branch");
  }
  const branch = this.branchIndex;

  // TSTALLOC sequence: vcvsset.c:53-58, line-for-line
  this._hPIbr    = solver.allocElement(posNode,     branch);      // :53
  this._hNIbr    = solver.allocElement(negNode,     branch);      // :54
  this._hIbrP    = solver.allocElement(branch,      posNode);     // :55
  this._hIbrN    = solver.allocElement(branch,      negNode);     // :56
  this._hIbrCtP  = solver.allocElement(branch,      ctrlPosNode); // :57
  this._hIbrCtN  = solver.allocElement(branch,      ctrlNegNode); // :58
}
```

`pinNodeIds` index ordering matches `buildVCVSPinDeclarations()`:
index 0 = `ctrl+`, index 1 = `ctrl-`, index 2 = `out+`, index 3 = `out-`.
(The factory passes `pinNodes.get(label)` already resolved; setup reads
`this.pinNodeIds` which is the resolved array in pinLayout order.)

All 6 handles stored on the element instance. `allocElement` NEVER called from
`load()`.

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/vcvs/vcvsload.c`
line-for-line. No `allocElement`. Stamps:

- `_hPIbr` += +1 (B[posNode, branch])
- `_hNIbr` += -1 (B[negNode, branch])
- `_hIbrP` += +1 (C[branch, posNode])
- `_hIbrN` += -1 (C[branch, negNode])
- `_hIbrCtP` += -gain (C[branch, ctrlPosNode]) — Jacobian
- `_hIbrCtN` += +gain (C[branch, ctrlNegNode]) — Jacobian
- `rhs[branch]` += NR constant term

(For nonlinear expressions, gain is replaced by the evaluated derivative f'(Vctrl)
and the RHS constant is f(Vctrl0) - f'(Vctrl0)*Vctrl0.)

## findBranchFor

VCVS must register a `findBranchFor` callback on its MnaModel so that CCCS/CCVS
that sense the VCVS output current can lazily resolve it. Mirrors
`VSRCfindBr` (`vsrc/vsrcfbr.c:26-39`):

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

This callback is attached to the `behavioral` MnaModel entry:
```typescript
findBranchFor(name, ctx) { ... }
```

## Sense-source resolution (CCCS, CCVS only)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory (the inline factory in
  `VCVSDefinition.modelRegistry["behavioral"]`). New signature:
  `factory(pinNodes, props, getTime): AnalogElementCore`.
- Drop `branchCount: 1` from MnaModel registration.
- Add `ngspiceNodeMap: { "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }`.
- Add `findBranchFor` callback (see above).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-VCVS is GREEN: insertion order must be
   `[(posNode,branch), (negNode,branch), (branch,posNode), (branch,negNode),
     (branch,ctrlPosNode), (branch,ctrlNegNode)]`.
2. `src/components/active/__tests__/vcvs.test.ts` is GREEN.
- **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
