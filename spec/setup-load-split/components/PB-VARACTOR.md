# Task PB-VARACTOR

**digiTS file:** `src/components/semiconductors/varactor.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/dio/diosetup.c:198-238`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/dio/dioload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS label | ngspice variable | Note |
|---|---|---|
| `A` | `DIOposNode` | Anode — external positive terminal |
| `K` | `DIOnegNode` | Cathode — external negative terminal |
| `internal` | `DIOposPrimeNode` | Internal node created when RS ≠ 0 |

```
const posNode = pinNodes.get("A")!;   // DIOposNode
const negNode = pinNodes.get("K")!;   // DIOnegNode
```

## Variant relationship

Varactor is a property-tuned variant of DIO. The setup anchor, internal-node
conditional, state-slot count, and TSTALLOC sequence are **identical** to
PB-DIO. The varactor's voltage-variable capacitance behaviour is implemented
entirely in load() via the junction-capacitance path (`CJO`, `VJ`, `M`
parameters); setup() is unchanged.

Property differences from plain Diode:

| Property | Diode default | Varactor tuning |
|---|---|---|
| `CJO` | 0 | set (e.g. 10–100 pF) — capacitance dominates |
| `VJ` | 1.0 V | junction potential (tuned for C-V curve) |
| `M` | 0.5 | grading coefficient (abrupt=0.5, hyper-abrupt>0.5) |
| `IS` | 1e-14 A | typically small (reverse-biased in use) |
| `RS` | 0 | series resistance (small) |
| `TT` | 0 | transit time (typically 0 for varactor) |

The `CJO`/`VJ`/`M` C-V formula and its companion stamping live in `dioload.c`;
setup() body is byte-identical to PB-DIO.

## Internal nodes

Same conditional as PB-DIO — see `diosetup.c:204-224`.

```ts
this._posPrimeNode = (this._model.RS === 0)
  ? posNode
  : ctx.makeVolt(this.label, "internal");
```

## Branch rows

None.

## State slots

`*states += 5` at `diosetup.c:199`. Identical to PB-DIO.

```ts
this._stateOffset = ctx.allocStates(5);
```

## TSTALLOC sequence (line-for-line port)

Identical to PB-DIO — `diosetup.c:232-238`, 7 entries.

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `DIOposPosPrimePtr` | `DIOposNode` | `DIOposPrimeNode` | `this._hPosPP` |
| 2 | `DIOnegPosPrimePtr` | `DIOnegNode` | `DIOposPrimeNode` | `this._hNegPP` |
| 3 | `DIOposPrimePosPtr` | `DIOposPrimeNode` | `DIOposNode` | `this._hPPPos` |
| 4 | `DIOposPrimeNegPtr` | `DIOposPrimeNode` | `DIOnegNode` | `this._hPPNeg` |
| 5 | `DIOposPosPtr` | `DIOposNode` | `DIOposNode` | `this._hPosPos` |
| 6 | `DIOnegNegPtr` | `DIOnegNode` | `DIOnegNode` | `this._hNegNeg` |
| 7 | `DIOposPrimePosPrimePtr` | `DIOposPrimeNode` | `DIOposPrimeNode` | `this._hPPPP` |

RS=0 collapse behaviour is identical to PB-DIO — see that spec.

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver  = ctx.solver;
  const posNode = this._pinNodes.get("A")!;
  const negNode = this._pinNodes.get("K")!;

  // State slots — diosetup.c:198-199
  this._stateOffset = ctx.allocStates(5);

  // Internal node — diosetup.c:204-224
  this._posPrimeNode = (this._model.RS === 0)
    ? posNode
    : ctx.makeVolt(this.label, "internal");

  // TSTALLOC sequence — diosetup.c:232-238 (identical to PB-DIO)
  this._hPosPP  = solver.allocElement(posNode,            this._posPrimeNode);
  this._hNegPP  = solver.allocElement(negNode,            this._posPrimeNode);
  this._hPPPos  = solver.allocElement(this._posPrimeNode, posNode);
  this._hPPNeg  = solver.allocElement(this._posPrimeNode, negNode);
  this._hPosPos = solver.allocElement(posNode,            posNode);
  this._hNegNeg = solver.allocElement(negNode,            negNode);
  this._hPPPP   = solver.allocElement(this._posPrimeNode, this._posPrimeNode);
}
```

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/dio/dioload.c` line-for-line, including full junction-capacitance path for `CJO`/`VJ`/`M`, stamping through cached handles. No allocElement calls.

## findBranchFor (if applicable)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `hasBranchRow: false`.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { A: "pos", K: "neg" }`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-VARACTOR is GREEN.
2. `src/components/semiconductors/__tests__/varactor.test.ts` is GREEN.
3. No banned closing verdicts.
