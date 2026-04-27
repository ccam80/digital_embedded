# Task PB-ZENER

**digiTS file:** `src/components/semiconductors/zener.ts`
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

Zener is a property-tuned variant of DIO. The setup anchor, internal-node
conditional, state-slot count, and TSTALLOC sequence are **identical** to
PB-DIO. The Zener characteristic is expressed entirely through model
parameter values and the load() body's breakdown voltage branch; setup()
is unchanged.

Property differences from plain Diode:

| Property | Diode default | Zener tuning |
|---|---|---|
| `BV` | ∞ (off) | set to breakdown voltage (e.g. 5.1 V) |
| `IBV` | 1e-3 A | default 1e-3 A |
| `RS` | 0 | typically small (0.5–5 Ω for a real Zener) |

The `BV`/`IBV` path in `dioload.c` fires when `model->DIObv` is set and
the reverse voltage exceeds `BV`; that is a load() concern, not setup().

## Internal nodes

Same conditional as PB-DIO — see `diosetup.c:204-224`. Verbatim port:

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
this._stateBase = ctx.allocStates(5);
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
  this._stateBase = ctx.allocStates(5);

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

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/dio/dioload.c` line-for-line, including the `BV`/`IBV` breakdown branch, stamping through cached handles. No allocElement calls.

- Preserve multiplicity scaling: all current and conductance stamps are multiplied by the instance `M` parameter (default 1.0). ngspice anchor: `dioload.c` / `mos1load.c` / `bjtload.c` / `jfetload.c` use `here->{DIO|MOS1|BJT|JFET}m` for this scaling. The instance `M` parameter is partition: "instance" per the in-progress phase-instance-vs-model-param-partition work.

## findBranchFor (if applicable)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { A: "pos", K: "neg" }`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-ZENER is GREEN.
2. `src/components/semiconductors/__tests__/zener.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
