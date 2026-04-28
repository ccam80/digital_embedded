# Task PB-VCCS

**digiTS file:** `src/components/active/vccs.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/vccs/vccsset.c:43-46`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/vccs/vccsload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS pin label | ngspice node suffix | Usage in setup() |
|---|---|---|
| `out+` | `pos` → VCCSposNode | `pinNodes.get("out+")` |
| `out-` | `neg` → VCCSnegNode | `pinNodes.get("out-")` |
| `ctrl+` | `contPos` → VCCScontPosNode | `pinNodes.get("ctrl+")` |
| `ctrl-` | `contNeg` → VCCScontNegNode | `pinNodes.get("ctrl-")` |

`ngspiceNodeMap: { "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }`

## Internal nodes

None. VCCS has no internal voltage nodes.

## Branch rows

None. VCCS uses a Norton stamp — no branch variable.

## State slots

0. `NG_IGNORE(states)` — vccsset.c performs no `*states +=` increment.
   `NG_IGNORE(ckt)` — no `CKTmkCur` call.

## TSTALLOC sequence (line-for-line port from vccsset.c:43-46)

| # | ngspice line | ngspice args | digiTS allocElement args |
|---|---|---|---|
| 1 | `:43` `TSTALLOC(VCCSposContPosptr, VCCSposNode, VCCScontPosNode)` | (posNode, contPosNode) | `(posNode, ctrlPosNode)` |
| 2 | `:44` `TSTALLOC(VCCSposContNegptr, VCCSposNode, VCCScontNegNode)` | (posNode, contNegNode) | `(posNode, ctrlNegNode)` |
| 3 | `:45` `TSTALLOC(VCCSnegContPosptr, VCCSnegNode, VCCScontPosNode)` | (negNode, contPosNode) | `(negNode, ctrlPosNode)` |
| 4 | `:46` `TSTALLOC(VCCSnegContNegptr, VCCSnegNode, VCCScontNegNode)` | (negNode, contNegNode) | `(negNode, ctrlNegNode)` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode     = this.pinNodeIds[2]; // pinNodes.get("out+")  — VCCSposNode
  const negNode     = this.pinNodeIds[3]; // pinNodes.get("out-")  — VCCSnegNode
  const ctrlPosNode = this.pinNodeIds[0]; // pinNodes.get("ctrl+") — VCCScontPosNode
  const ctrlNegNode = this.pinNodeIds[1]; // pinNodes.get("ctrl-") — VCCScontNegNode

  // TSTALLOC sequence: vccsset.c:43-46, line-for-line
  this._hPCtP = solver.allocElement(posNode, ctrlPosNode); // :43
  this._hPCtN = solver.allocElement(posNode, ctrlNegNode); // :44
  this._hNCtP = solver.allocElement(negNode, ctrlPosNode); // :45
  this._hNCtN = solver.allocElement(negNode, ctrlNegNode); // :46
}
```

`pinNodeIds` index ordering matches `buildVCCSPinDeclarations()`:
index 0 = `ctrl+`, index 1 = `ctrl-`, index 2 = `out+`, index 3 = `out-`.

All 4 handles stored on the element instance. `allocElement` NEVER called from
`load()`.

## VccsAnalogElement.stamps — readonly accessor for composite users

VccsAnalogElement exposes its four TSTALLOC handles via a readonly accessor for composites that need to stamp through the VCCS without owning the handle fields directly:

```ts
get stamps(): { pCtP: number; pCtN: number; nCtP: number; nCtN: number } {
  return {
    pCtP: this._hPCtP,
    pCtN: this._hPCtN,
    nCtP: this._hNCtP,
    nCtN: this._hNCtN,
  };
}
```

The accessor returns a fresh object on every call — composite consumers (PB-TUNNEL, PB-TRIODE) typically destructure once into local consts at the start of `load()` rather than calling per-iteration. Renaming or restructuring private handle fields does NOT break composite consumers as long as the accessor's return shape is preserved.

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/vccs/vccsload.c`
line-for-line. No `allocElement`. Stamps the Norton transconductance matrix:

```typescript
load(ctx: LoadContext): void {
  const gm  = derivative; // f'(Vctrl) evaluated at current Vctrl
  const iNR = value - derivative * ctrlValue; // NR constant term

  ctx.solver.stampElement(this._hPCtP, -gm);  // G[posNode, ctrlPosNode]
  ctx.solver.stampElement(this._hPCtN,  gm);  // G[posNode, ctrlNegNode]
  ctx.solver.stampElement(this._hNCtP,  gm);  // G[negNode, ctrlPosNode]
  ctx.solver.stampElement(this._hNCtN, -gm);  // G[negNode, ctrlNegNode]

  rhs[posNode] += iNR;
  rhs[negNode] -= iNR;
}
```

(Signs follow the MNA Norton convention: current gm*Vctrl injected INTO posNode
requires G[posNode, ctrlPosNode] = -gm so the KCL term is -gm*VctrlP.)

## findBranchFor (if applicable)

Not applicable. VCCS has no branch row and therefore needs no `findBranchFor`
callback. Controlling sources (CCCS/CCVS) that sense a VCCS output current
cannot do so — only VSRC, IND, VCVS, and CCVS output branch variables are
senseable. This is consistent with ngspice: VCCSfindBr does not exist.

## Sense-source resolution (CCCS, CCVS only)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory (the inline factory in
  `VCCSDefinition.modelRegistry["behavioral"]`). New signature:
  `factory(pinNodes, props, getTime): AnalogElementCore`.
- Drop any `branchCount` field (was absent; confirm it stays absent).
- Add `ngspiceNodeMap: { "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }`.
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
