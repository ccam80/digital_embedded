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

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body — alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only — zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
