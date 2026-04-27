# Task PB-ISRC

**digiTS file:** `src/components/sources/current-source.ts`
**ngspice setup anchor:** `none — ISRC has no *set.c file (no-op setup is correct)`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/isrc/isrcload.c`

Verification: `ref/ngspice/src/spicelib/devices/isrc/` contains the following files and no `*set.c` among them:
`isrc.c`, `isrcacct.c`, `isrcacld.c`, `isrcask.c`, `isrcdefs.h`, `isrcdel.c`, `isrcdest.c`, `isrcext.h`, `isrcinit.c`, `isrcinit.h`, `isrcitf.h`, `isrcload.c`, `Makefile.am`, `isrcmdel.c`, `isrcpar.c`, `isrctemp.c`. The absence of `isrcset.c` is confirmed — no-op setup is correct for ISRC.

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { neg: "neg", pos: "pos" }`

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `neg` | `ISRCnegNode` | `"neg"` |
| `pos` | `ISRCposNode` | `"pos"` |

## Internal nodes

none

## Branch rows

none — ISRC injects current directly into `CKTrhs` without a branch row.

## State slots

none

## TSTALLOC sequence (line-for-line port)

none — no setup file exists; no `SMPmakeElt` calls anywhere in the isrc device directory.

## setup() body — alloc only

```typescript
setup(_ctx: SetupContext): void {
  // ISRC has no *set.c in ngspice. No TSTALLOC, no internal nodes,
  // no branch row, no state slots. Body is intentionally empty.
}
```

## load() body — value writes only

Implementer ports value-side from `isrcload.c` line-for-line, stamping through cached handles. No allocElement calls.

ISRC stamps onto `CKTrhs` only — no matrix stamps. From isrcload.c:399-400:
```typescript
// isrcload.c:399-400 — RHS only, no matrix stamps
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

1. `setup-stamp-order.test.ts` row for PB-ISRC is GREEN (empty sequence — zero allocElement calls).
2. `src/components/sources/__tests__/current-source.test.ts` is GREEN.
- **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
