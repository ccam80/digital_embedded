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

1. `setup-stamp-order.test.ts` row for PB-MEMR is GREEN (insertion order: PP, NN, PN, NP = 4 total; ground-skip applied when either pin is ground).
2. Memristor test file (if it exists) is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence) used in any commit message or report.
