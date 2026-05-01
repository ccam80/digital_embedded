# Task PB-ISRC

**digiTS file:** `src/components/sources/current-source.ts`
**ngspice setup anchor:** `none- ISRC has no *set.c file (no-op setup is correct)`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/isrc/isrcload.c`

Verification: `ref/ngspice/src/spicelib/devices/isrc/` contains the following files and no `*set.c` among them:
`isrc.c`, `isrcacct.c`, `isrcacld.c`, `isrcask.c`, `isrcdefs.h`, `isrcdel.c`, `isrcdest.c`, `isrcext.h`, `isrcinit.c`, `isrcinit.h`, `isrcitf.h`, `isrcload.c`, `Makefile.am`, `isrcmdel.c`, `isrcpar.c`, `isrctemp.c`. The absence of `isrcset.c` is confirmed- no-op setup is correct for ISRC.

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { neg: "neg", pos: "pos" }`

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `neg` | `ISRCnegNode` | `"neg"` |
| `pos` | `ISRCposNode` | `"pos"` |

## Internal nodes

none

## Branch rows

none- ISRC injects current directly into `CKTrhs` without a branch row.

## State slots

none

## TSTALLOC sequence (line-for-line port)

none- no setup file exists; no `SMPmakeElt` calls anywhere in the isrc device directory.

## setup() body- alloc only

```typescript
setup(_ctx: SetupContext): void {
  // ISRC has no *set.c in ngspice. No TSTALLOC, no internal nodes,
  // no branch row, no state slots. Body is intentionally empty.
}
```

## load() body- value writes only

Implementer ports value-side from `isrcload.c` line-for-line, stamping through cached handles. No allocElement calls.

ISRC stamps onto `CKTrhs` only- no matrix stamps. From isrcload.c:399-400:
```typescript
// isrcload.c:399-400- RHS only, no matrix stamps
ctx.rhs[posNode] += m * value;
ctx.rhs[negNode] -= m * value;
```
where `value` is computed from the waveform type (DC, PULSE, SINE, EXP, SFFM, AM, PWL, TRNOISE, TRRANDOM) following the same switch as vsrcload.c, and `m` is the multiplicity parameter (`ISRCmValue`, default 1.0).

## findBranchFor (not applicable)

ISRC has no branch row; `findBranchFor` is not registered.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `ngspiceNodeMap: { neg: "neg", pos: "pos" }`.
- No `findBranchFor` callback.

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
