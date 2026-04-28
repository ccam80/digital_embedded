# Task PB-MEMR

**digiTS file:** `src/components/passives/memristor.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49` (state-dependent RES)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/res/resload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { A: "pos", B: "neg" }`.

| digiTS pin label | pinNodes key | ngspice node variable |
|---|---|---|
| `A` | `pinNodes.get("A")` | `RESposNode` |
| `B` | `pinNodes.get("B")` | `RESnegNode` |

**Note for coordinator:** `01-pin-mapping.md` describes the memristor as "1× VCCS (state-dependent g)" but the correct pattern is 1× RES (state-dependent G). The TSTALLOC table above gives the correct RES sequence. `01-pin-mapping.md` may need to be corrected separately to change MEMR from 1× VCCS to 1× RES (state-dependent G). Coordinator should flag this for separate fix.

## Internal nodes

None. The memristor is a two-terminal conductance with no internal topology.

## Branch rows

None. The memristor stamps conductance directly — no branch current row.

## State slots

None allocated from the `StatePool`. The memristor's internal state variable `_w` (normalised doped-region boundary, 0 to 1) is an ordinary TypeScript instance field on `MemristorElement`, not a StatePool slot. It is integrated in `accept()` via Euler forward. No `ctx.allocStates()` call is needed in `setup()`.

## TSTALLOC sequence (line-for-line port)

The memristor applies `ressetup.c:46-49` once (posNode = A, negNode = B).

**Ground-node skip rule:** The existing `load()` uses `stampG(solver, nA, nA, G)` etc., which internally skips ground rows/columns. In `setup()`, `allocElement` does not automatically skip ground — the implementer must apply explicit checks for each entry. This matches the pattern used in `AnalogFuseElement.setup()` (PB-AFUSE).

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(aNode, aNode)` | `_hPP` |
| 2 | `(RESnegNode, RESnegNode)` | `(bNode, bNode)` | `_hNN` |
| 3 | `(RESposNode, RESnegNode)` | `(aNode, bNode)` | `_hPN` |
| 4 | `(RESnegNode, RESposNode)` | `(bNode, aNode)` | `_hNP` |

Total: 4 TSTALLOC entries (matching ressetup.c:46-49 exactly; subject to ground-skip guards).

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const aNode = this._pinNodes.get("A")!;  // A pin — RESposNode
  const bNode = this._pinNodes.get("B")!;  // B pin — RESnegNode

  // ressetup.c:46-49 — TSTALLOC sequence, line-for-line.
  if (aNode !== 0) this._hPP = solver.allocElement(aNode, aNode);
  if (bNode !== 0) this._hNN = solver.allocElement(bNode, bNode);
  if (aNode !== 0 && bNode !== 0) {
    this._hPN = solver.allocElement(aNode, bNode);
    this._hNP = solver.allocElement(bNode, aNode);
  }
}
```

Fields to add to `MemristorElement`:
```ts
private _hPP: number = -1;
private _hNN: number = -1;
private _hPN: number = -1;
private _hNP: number = -1;
```

**Note on _pinNodes:** The current `MemristorElement` has `pinNodeIds!: readonly number[]` (non-null asserted, set via `Object.assign` after factory returns). After migration, the factory receives `pinNodes: ReadonlyMap<string, number>` and stores it as `this._pinNodes = pinNodes` directly in the constructor. The `setup()` reads from `this._pinNodes.get("A")!` and `this._pinNodes.get("B")!` as shown above.

## load() body — value writes only

Implementer ports the state-dependent conductance stamp from `ref/ngspice/src/spicelib/devices/res/resload.c`, using the memristor's current conductance `G = this.conductance()`:
- `solver.stampElement(_hPP, G)` — aNode diagonal
- `solver.stampElement(_hNN, G)` — bNode diagonal
- `solver.stampElement(_hPN, -G)` — off-diagonal
- `solver.stampElement(_hNP, -G)` — off-diagonal

with the same ground-skip guards used in `setup()` (only stamp `_hPN`/`_hNP` when `_hPN !== -1`).

No `solver.allocElement` calls in `load()`. The `accept()` method (Euler forward integration of `_w` via Joglekar window) remains unchanged.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createMemristorElement` factory signature (per A6.3). The current factory already ignores them (`_internalNodeIds`, `_branchIdx`).
- Add `pinNodes` usage: construct `MemristorElement` with `pinNodeIds = [pinNodes.get("A")!, pinNodes.get("B")!]` set at construction time rather than via `Object.assign`.
- No `branchCount` existed on this `modelRegistry` entry — no removal needed.
- `mayCreateInternalNodes` omitted.
- Add `ngspiceNodeMap: { A: "pos", B: "neg" }` to `ComponentDefinition`.
- No `findBranchFor` callback (no branch row).

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
