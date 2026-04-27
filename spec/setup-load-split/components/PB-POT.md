# Task PB-POT

**digiTS file:** `src/components/passives/potentiometer.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49` (2× RES decomposition)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/res/resload.c`

## Pin mapping (from 01-pin-mapping.md)

The potentiometer composite decomposes into two resistors. The composite has no `ngspiceNodeMap` on `ComponentDefinition`. Sub-element maps:

- `R_AW` (resistor between A and W): `{ A: "pos", W: "neg" }`
- `R_WB` (resistor between W and B): `{ W: "pos", B: "neg" }`

| Sub-element | digiTS pin label | pin map key | ngspice node variable |
|---|---|---|---|
| R_AW | `A` | pos | `RESposNode` |
| R_AW | `W` | neg | `RESnegNode` |
| R_WB | `W` | pos | `RESposNode` |
| R_WB | `B` | neg | `RESnegNode` |

## Internal nodes

None. RES has no `CKTmkVolt` calls.

## Branch rows

None. RES has no `CKTmkCur` calls.

## State slots

None. `ressetup.c` does `NG_IGNORE(state)`.

## TSTALLOC sequence (line-for-line port)

The potentiometer applies `ressetup.c:46-49` twice — once for `R_AW`, once for `R_WB`.

### R_AW setup (A=posNode, W=negNode)

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(aNode, aNode)` | `_hAW_PP` |
| 2 | `(RESnegNode, RESnegNode)` | `(wNode, wNode)` | `_hAW_NN` |
| 3 | `(RESposNode, RESnegNode)` | `(aNode, wNode)` | `_hAW_PN` |
| 4 | `(RESnegNode, RESposNode)` | `(wNode, aNode)` | `_hAW_NP` |

### R_WB setup (W=posNode, B=negNode)

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 5 | `(RESposNode, RESposNode)` | `(wNode, wNode)` | `_hWB_PP` |
| 6 | `(RESnegNode, RESnegNode)` | `(bNode, bNode)` | `_hWB_NN` |
| 7 | `(RESposNode, RESnegNode)` | `(wNode, bNode)` | `_hWB_PN` |
| 8 | `(RESnegNode, RESposNode)` | `(bNode, wNode)` | `_hWB_NP` |

Note on handle sharing: `_hAW_NN` and `_hWB_PP` both address `(wNode, wNode)`. `solver.allocElement` is idempotent for duplicate `(row, col)` pairs — the same handle index is returned on the second call. The implementer should be aware that `_hAW_NN === _hWB_PP` after setup, and both stamping calls accumulate onto the same matrix entry (which is the correct MNA behavior — the wiper node diagonal receives contributions from both resistors).

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const aNode = this.pinNodeIds[0];  // A pin — R_AW posNode
  const bNode = this.pinNodeIds[1];  // B pin — R_WB negNode (note: potentiometer.ts
                                     //   factory passes [A, B, W] but the AnalogPotentiometerElement
                                     //   constructor receives [A, W, B] reordering — verify against
                                     //   the createPotentiometerElement call in potentiometer.ts:266)
  const wNode = this.pinNodeIds[2];  // W pin — shared wiper node

  // R_AW — ressetup.c:46-49 (A as posNode, W as negNode)
  this._hAW_PP = solver.allocElement(aNode, aNode);  // (RESposNode, RESposNode)
  this._hAW_NN = solver.allocElement(wNode, wNode);  // (RESnegNode, RESnegNode)
  this._hAW_PN = solver.allocElement(aNode, wNode);  // (RESposNode, RESnegNode)
  this._hAW_NP = solver.allocElement(wNode, aNode);  // (RESnegNode, RESposNode)

  // R_WB — ressetup.c:46-49 (W as posNode, B as negNode)
  this._hWB_PP = solver.allocElement(wNode, wNode);  // (RESposNode, RESposNode)
  this._hWB_NN = solver.allocElement(bNode, bNode);  // (RESnegNode, RESnegNode)
  this._hWB_PN = solver.allocElement(wNode, bNode);  // (RESposNode, RESnegNode)
  this._hWB_NP = solver.allocElement(bNode, wNode);  // (RESnegNode, RESposNode)
}
```

**Pin order verification note:** The existing `createPotentiometerElement` at potentiometer.ts:266 passes `[pinNodes.get("A")!, pinNodes.get("B")!, pinNodes.get("W")!]` to `AnalogPotentiometerElement`, but the `load()` code treats `pinNodeIds[0]=n_A`, `pinNodeIds[1]=n_W`, `pinNodeIds[2]=n_B` — there is a label mismatch between the constructor comment and the actual ordering. The implementer must verify the actual pin index → node mapping in the current code before writing the setup body, and correct the field naming accordingly.

Fields to add to `AnalogPotentiometerElement`:
```ts
private _hAW_PP: number = -1;  private _hAW_NN: number = -1;
private _hAW_PN: number = -1;  private _hAW_NP: number = -1;
private _hWB_PP: number = -1;  private _hWB_NN: number = -1;
private _hWB_PN: number = -1;  private _hWB_NP: number = -1;
```

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/res/resload.c` line-for-line, applied twice (once for R_AW, once for R_WB). Each resistor's conductance is position-dependent:
- `G_AW = 1 / max(R * position, MIN_RESISTANCE)`
- `G_WB = 1 / max(R * (1 - position), MIN_RESISTANCE)`

`setParam("position", v)` updates both — `G_AW = G_total * v`, `G_WB = G_total * (1 - v)`. All stamps use cached handles only. No `solver.allocElement` calls.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createPotentiometerElement` factory signature (per A6.3).
- No `branchCount` or `getInternalNodeCount` existed; no removal needed.
- Add `hasBranchRow: false` to `MnaModel` registration.
- `mayCreateInternalNodes` omitted.
- `ComponentDefinition.ngspiceNodeMap` left undefined (composite decomposes).
- No `findBranchFor` callback.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-POT is GREEN (insertion order: R_AW×4, R_WB×4 = 8 total; note (wNode,wNode) appears at positions 2 and 5 and returns the same handle).
2. Potentiometer test file is GREEN.
3. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence) used in any commit message or report.
