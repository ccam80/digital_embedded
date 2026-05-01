# Task PB-AFUSE

> **Spec-doc duplication note (added during remediation-pass-1):** This is the
> single source of truth for the analog `FuseElement`. PB-FUSE.md describes the
> same implementation from the perspective of the `switching/fuse.ts` digital
> wrapper (whose `modelRegistry["behavioral"]` imports `createAnalogFuseElement`
> from this file). When this spec is satisfied, both PB-AFUSE and PB-FUSE are
> satisfied. Consolidation with PB-FUSE.md is deferred.
>
> **Status:** migrated (during 5.B.fuse). Verified spec-compliant during
> remediation-pass-1. `5.B.passives-simple` inherits this as complete and must
> not re-migrate.

**digiTS file:** `src/components/passives/analog-fuse.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49` (variable RES)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/res/resload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { out1: "pos", out2: "neg" }`.

| digiTS pin label | pinNodes key | ngspice node variable |
|---|---|---|
| `out1` | `pinNodes.get("out1")` | `RESposNode` |
| `out2` | `pinNodes.get("out2")` | `RESnegNode` |

## Internal nodes

None. The analog fuse is a pure variable RES with no internal topology.

## Branch rows

None. The fuse stamps conductance directly- no branch current row.

## State slots

None allocated from the `StatePool`. The fuse's thermal energy accumulator (`_thermalEnergy`) is an ordinary TypeScript instance field on `AnalogFuseElement`, not a StatePool slot. It is integrated in `accept()`. No `ctx.allocStates()` call is needed in `setup()`.

## TSTALLOC sequence (line-for-line port)

The analog fuse applies `ressetup.c:46-49` once (posNode = out1, negNode = out2).

**Ground-node skip rule:** The existing `load()` applies explicit ground checks via `if (nPos !== 0 && nNeg !== 0)` / `else if (nPos !== 0)` / `else if (nNeg !== 0)`. In `setup()`, the same guards must be applied to each `allocElement` call because ground rows/columns are not part of the reduced MNA system.

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(posNode, posNode)` | `_hPP` |
| 2 | `(RESnegNode, RESnegNode)` | `(negNode, negNode)` | `_hNN` |
| 3 | `(RESposNode, RESnegNode)` | `(posNode, negNode)` | `_hPN` |
| 4 | `(RESnegNode, RESposNode)` | `(negNode, posNode)` | `_hNP` |

Total: 4 TSTALLOC entries (matching ressetup.c:46-49 exactly; subject to ground-skip guards).

## setup() body- alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this._pinNodes.get("out1")!;  // RESposNode
  const negNode = this._pinNodes.get("out2")!;  // RESnegNode

  // ressetup.c:46-49- TSTALLOC sequence, line-for-line.
  // Ground-skip guards mirror the existing load() checks.
  if (posNode !== 0) this._hPP = solver.allocElement(posNode, posNode);
  if (negNode !== 0) this._hNN = solver.allocElement(negNode, negNode);
  if (posNode !== 0 && negNode !== 0) {
    this._hPN = solver.allocElement(posNode, negNode);
    this._hNP = solver.allocElement(negNode, posNode);
  }
}
```

Fields to add to `AnalogFuseElement`:
```ts
private _hPP: number = -1;
private _hNN: number = -1;
private _hPN: number = -1;
private _hNP: number = -1;
```

**Note on the existing ground-skip logic:** The current `load()` has three branches:
1. Both non-zero → stamp all 4 entries
2. Only posNode non-zero → stamp only `(posNode, posNode)`
3. Only negNode non-zero → stamp only `(negNode, negNode)`

The `setup()` body must mirror these exactly so that only the handles that will actually be written by `load()` are allocated. The implementation above does this correctly: `_hPP` is allocated when `posNode !== 0`; `_hNN` when `negNode !== 0`; `_hPN` and `_hNP` only when both are non-zero.

## load() body- value writes only

Implementer ports the variable conductance stamp from `ref/ngspice/src/spicelib/devices/res/resload.c`, applying the smooth-resistance `smoothResistance(_thermalEnergy, ...)` to get `G`, then stamping:
- `solver.stampElement(_hPP, G)`- posNode diagonal
- `solver.stampElement(_hNN, G)`- negNode diagonal
- `solver.stampElement(_hPN, -G)`- off-diagonal
- `solver.stampElement(_hNP, -G)`- off-diagonal

with the same ground-skip guards used in `setup()` (only stamp `_hPN`/`_hNP` when both handles are valid, i.e., `_hPN !== -1`).

No `solver.allocElement` calls in `load()`. The `accept()` method (I²t integration and state propagation) remains unchanged.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createAnalogFuseElement` factory signature (per A6.3). The current factory already ignores them (`_internalNodeIds`, `_branchIdx`).
- No `branchCount` existed on this `modelRegistry` entry- no removal needed.
- `mayCreateInternalNodes` omitted.
- Add `ngspiceNodeMap: { out1: "pos", out2: "neg" }` to `ComponentDefinition`.
- No `findBranchFor` callback (no branch row).

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
