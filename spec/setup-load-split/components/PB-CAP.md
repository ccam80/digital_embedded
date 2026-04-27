# Task PB-CAP

**digiTS file:** `src/components/passives/capacitor.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/cap/capsetup.c:102-117`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/cap/capload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { pos: "pos", neg: "neg" }`.

| digiTS pin label | pinNodes key | ngspice node variable |
|---|---|---|
| `pos` | `pinNodes.get("pos")` | `CAPposNode` |
| `neg` | `pinNodes.get("neg")` | `CAPnegNode` |

## Internal nodes

None. `CAPsetup.c` makes no `CKTmkVolt` calls.

## Branch rows

None. `CAPsetup.c` makes no `CKTmkCur` calls.

## State slots

`capsetup.c:102-103`:
```c
here->CAPqcap = *states;
*states += 2;
```

Two state slots allocated. digiTS port: `this._stateBase = ctx.allocStates(2)`.

Note: the sensitivity `*states += 2 * SENparms` block at line 104-106 is conditional on `CKTsenInfo` which digiTS does not implement — omit.

## TSTALLOC sequence (line-for-line port)

`capsetup.c:114-117` — four unconditional TSTALLOC calls:

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(CAPposNode, CAPposNode)` | `(pinNodes.get("pos"), pinNodes.get("pos"))` | `_hPP` |
| 2 | `(CAPnegNode, CAPnegNode)` | `(pinNodes.get("neg"), pinNodes.get("neg"))` | `_hNN` |
| 3 | `(CAPposNode, CAPnegNode)` | `(pinNodes.get("pos"), pinNodes.get("neg"))` | `_hPN` |
| 4 | `(CAPnegNode, CAPposNode)` | `(pinNodes.get("neg"), pinNodes.get("pos"))` | `_hNP` |

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = pinNodes.get("pos")!;  // CAPposNode
  const negNode = pinNodes.get("neg")!;  // CAPnegNode

  // capsetup.c:102-103 — *states += 2 (CAPqcap slot)
  this._stateBase = ctx.allocStates(2);

  // capsetup.c:114-117 — TSTALLOC sequence, line-for-line.
  this._hPP = solver.allocElement(posNode, posNode);  // (CAPposNode, CAPposNode)
  this._hNN = solver.allocElement(negNode, negNode);  // (CAPnegNode, CAPnegNode)
  this._hPN = solver.allocElement(posNode, negNode);  // (CAPposNode, CAPnegNode)
  this._hNP = solver.allocElement(negNode, posNode);  // (CAPnegNode, CAPposNode)
}
```

Fields to add to `AnalogCapacitorElement`:
```ts
private _stateBase: number = -1;
private _hPP: number = -1;
private _hNN: number = -1;
private _hPN: number = -1;
private _hNP: number = -1;
```

The existing `AnalogCapacitorElement` currently allocates handles lazily inside `load()` via `_handlesInit`. After this migration, those lazy allocations are **removed** and the cached handles from `setup()` are used instead. The `_handlesInit` guard and `_hAA`/`_hBB`/`_hAB`/`_hBA` fields are replaced by `_hPP`/`_hNN`/`_hPN`/`_hNP`.

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/cap/capload.c` line-for-line, stamping through cached handles only. No `solver.allocElement` calls.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createCapacitorElement` factory signature (per A6.3).
- Drop any `branchCount` or `getInternalNodeCount` from `MnaModel` registration if present — confirm neither exists; neither needs adding.
- `mayCreateInternalNodes` omitted (no internal nodes).
- Add `ngspiceNodeMap: { pos: "pos", neg: "neg" }` to `ComponentDefinition` (`CapacitorDefinition`).
- No `findBranchFor` callback (no branch row).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-CAP is GREEN (insertion order: PP, NN, PN, NP).
2. `src/components/passives/__tests__/capacitor.test.ts` (or equivalent) is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence) used in any commit message or report.
