# Task PB-DIO

**digiTS file:** `src/components/semiconductors/diode.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/dio/diosetup.c:198-238`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/dio/dioload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS label | ngspice variable | Note |
|---|---|---|
| `A` | `DIOposNode` | Anode — external positive terminal |
| `K` | `DIOnegNode` | Cathode — external negative terminal |
| `internal` | `DIOposPrimeNode` | Internal node created when RS ≠ 0 |

```
const posNode      = pinNodes.get("A")!;   // DIOposNode
const negNode      = pinNodes.get("K")!;   // DIOnegNode
```

## Internal nodes

One conditional internal node. Verbatim gate from `diosetup.c:204-224`:

```c
if(model->DIOresist == 0) {
    here->DIOposPrimeNode = here->DIOposNode;
} else if(here->DIOposPrimeNode == 0) {
    error = CKTmkVolt(ckt, &tmp, here->DIOname, "internal");
    if(error) return(error);
    here->DIOposPrimeNode = tmp->number;
    /* copyNodesets block omitted — handled by engine */
}
```

digiTS port:

```ts
this._posPrimeNode = (model.RS === 0)
  ? posNode
  : ctx.makeVolt(this.label, "internal");
```

## Branch rows

None.

## State slots

`*states += 5` at `diosetup.c:199`. Offset stored in `here->DIOstate` at line 198.

```ts
this._stateOffset = ctx.allocStates(5);
```

## TSTALLOC sequence (line-for-line port)

`diosetup.c:232-238`. Seven entries. `pp` = `_posPrimeNode`.

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `DIOposPosPrimePtr` | `DIOposNode` | `DIOposPrimeNode` | `this._hPosPP` |
| 2 | `DIOnegPosPrimePtr` | `DIOnegNode` | `DIOposPrimeNode` | `this._hNegPP` |
| 3 | `DIOposPrimePosPtr` | `DIOposPrimeNode` | `DIOposNode` | `this._hPPPos` |
| 4 | `DIOposPrimeNegPtr` | `DIOposPrimeNode` | `DIOnegNode` | `this._hPPNeg` |
| 5 | `DIOposPosPtr` | `DIOposNode` | `DIOposNode` | `this._hPosPos` |
| 6 | `DIOnegNegPtr` | `DIOnegNode` | `DIOnegNode` | `this._hNegNeg` |
| 7 | `DIOposPrimePosPrimePtr` | `DIOposPrimeNode` | `DIOposPrimeNode` | `this._hPPPP` |

**RS=0 collapse note:** When `RS === 0`, `_posPrimeNode === posNode`. Entries (1) and (5) become `allocElement(posNode, posNode)` — same call twice. `allocElement` returns the existing handle on the second call (idempotent by design). No special-case needed in the port. Similarly entries (2) and (4) reduce: (2) stays `(negNode, posNode)`, (4) becomes `(posNode, negNode)`. Entry (3) becomes `(posNode, posNode)` — same as (5). Entry (7) becomes `(posNode, posNode)` — same again. The Translate mechanism returns the existing slot handle each time; load() uses all 7 handles regardless.

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver   = ctx.solver;
  const posNode  = this._pinNodes.get("A")!;
  const negNode  = this._pinNodes.get("K")!;

  // State slots — diosetup.c:198-199
  this._stateOffset = ctx.allocStates(5);

  // Internal node — diosetup.c:204-224
  this._posPrimeNode = (this._model.RS === 0)
    ? posNode
    : ctx.makeVolt(this.label, "internal");

  // TSTALLOC sequence — diosetup.c:232-238
  this._hPosPP  = solver.allocElement(posNode,           this._posPrimeNode); // (1)
  this._hNegPP  = solver.allocElement(negNode,           this._posPrimeNode); // (2)
  this._hPPPos  = solver.allocElement(this._posPrimeNode, posNode);           // (3)
  this._hPPNeg  = solver.allocElement(this._posPrimeNode, negNode);           // (4)
  this._hPosPos = solver.allocElement(posNode,           posNode);            // (5)
  this._hNegNeg = solver.allocElement(negNode,           negNode);            // (6)
  this._hPPPP   = solver.allocElement(this._posPrimeNode, this._posPrimeNode);// (7)
}
```

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/dio/dioload.c` line-for-line, stamping through cached handles. No allocElement calls.

## findBranchFor (if applicable)

Not applicable. DIO has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `hasBranchRow: false`.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { A: "pos", K: "neg" }`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-DIO is GREEN.
2. `src/components/semiconductors/__tests__/diode.test.ts` is GREEN.
3. No banned closing verdicts.
