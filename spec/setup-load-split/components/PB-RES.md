# Task PB-RES

**digiTS file:** `src/components/passives/resistor.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/res/resload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { A: "pos", B: "neg" }`.

| digiTS pin label | pinNodes key | ngspice node variable |
|---|---|---|
| `A` | `pinNodes.get("A")` | `RESposNode` |
| `B` | `pinNodes.get("B")` | `RESnegNode` |

## Internal nodes

None. `RESsetup.c` makes no `CKTmkVolt` calls.

## Branch rows

None. `RESsetup.c` makes no `CKTmkCur` calls. `NG_IGNORE(state)` at line 22 confirms the state pointer is unused.

## State slots

None. `RESsetup.c` does `NG_IGNORE(state)` — no `*states += N` line.

## TSTALLOC sequence (line-for-line port)

`ressetup.c:46-49` — four unconditional TSTALLOC calls:

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(pinNodes.get("A"), pinNodes.get("A"))` | `_hPP` |
| 2 | `(RESnegNode, RESnegNode)` | `(pinNodes.get("B"), pinNodes.get("B"))` | `_hNN` |
| 3 | `(RESposNode, RESnegNode)` | `(pinNodes.get("A"), pinNodes.get("B"))` | `_hPN` |
| 4 | `(RESnegNode, RESposNode)` | `(pinNodes.get("B"), pinNodes.get("A"))` | `_hNP` |

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = pinNodes.get("A")!;  // RESposNode
  const negNode = pinNodes.get("B")!;  // RESnegNode

  // ressetup.c:46-49 — TSTALLOC sequence, line-for-line.
  this._hPP = solver.allocElement(posNode, posNode);  // (RESposNode, RESposNode)
  this._hNN = solver.allocElement(negNode, negNode);  // (RESnegNode, RESnegNode)
  this._hPN = solver.allocElement(posNode, negNode);  // (RESposNode, RESnegNode)
  this._hNP = solver.allocElement(negNode, posNode);  // (RESnegNode, RESposNode)
}
```

Fields to add to the element class:
```ts
private _hPP: number = -1;
private _hNN: number = -1;
private _hPN: number = -1;
private _hNP: number = -1;
```

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/res/resload.c` line-for-line, stamping through cached handles only. No `solver.allocElement` calls.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createResistorElement` factory signature (per A6.3).
- Drop `branchCount` and `getInternalNodeCount` from `MnaModel` registration (per A6.2) — neither was present; confirm no addition needed.
- `mayCreateInternalNodes` omitted (no internal nodes).
- Add `ngspiceNodeMap: { A: "pos", B: "neg" }` to `ComponentDefinition` (`ResistorDefinition`).
- No `findBranchFor` callback (no branch row).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-RES is GREEN (insertion order: PP, NN, PN, NP).
2. `src/components/passives/__tests__/resistor.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence) used in any commit message or report.
