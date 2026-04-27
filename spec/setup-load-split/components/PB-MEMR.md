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

**Implementation note:** `01-pin-mapping.md` describes the memristor as "1× VCCS (state-dependent g)". The actual implementation in `memristor.ts` is a direct conductance stamp (four `stampG` calls in `load()`), structurally identical to a RES with a dynamically computed conductance `G(w)`. This is the correct pattern — there is no VCCS sub-element in the implementation. The setup pattern follows `ressetup.c:46-49` (the RES TSTALLOC sequence), not `vccssetup.c`. The W3 implementer should use the actual code as the reference, not the 01-pin-mapping.md VCCS description.

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
  const aNode = this.pinNodeIds[0];  // A pin — RESposNode
  const bNode = this.pinNodeIds[1];  // B pin — RESnegNode

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

**Note on pinNodeIds:** The current `MemristorElement` has `pinNodeIds!: readonly number[]` (non-null asserted, set via `Object.assign` after factory returns). After migration, the factory receives `pinNodes: ReadonlyMap<string, number>` and sets `pinNodeIds = [pinNodes.get("A")!, pinNodes.get("B")!]` directly in the constructor or factory. The `setup()` reads from `this.pinNodeIds[0]` and `this.pinNodeIds[1]` as normal.

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
- Add `hasBranchRow: false` to `MnaModel` registration.
- `mayCreateInternalNodes` omitted.
- Add `ngspiceNodeMap: { A: "pos", B: "neg" }` to `ComponentDefinition`.
- No `findBranchFor` callback (no branch row).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-MEMR is GREEN (insertion order: PP, NN, PN, NP = 4 total; ground-skip applied when either pin is ground).
2. Memristor test file (if it exists) is GREEN.
3. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence) used in any commit message or report.
