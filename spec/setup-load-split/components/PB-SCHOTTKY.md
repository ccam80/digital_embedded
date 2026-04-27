# Task PB-SCHOTTKY

**digiTS file:** `src/components/semiconductors/schottky.ts`
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

Schottky is a property-tuned variant of DIO. The setup anchor, internal-node
conditional, state-slot count, and TSTALLOC sequence are **identical** to
PB-DIO. Schottky behaviour (lower forward voltage, faster recovery) is
captured entirely through model parameter values; setup() is unchanged.

Property differences from plain Diode:

| Property | Diode default | Schottky tuning |
|---|---|---|
| `N` | 1.0 | typically 1.0–1.08 |
| `IS` | 1e-14 A | typically 1e-7 – 1e-5 A (larger saturation current → lower Vf) |
| `RS` | 0 | typically 0.1–1 Ω |
| `TT` | 0 | very small (fast recovery) |
| `CJO` | 0 | small junction cap |

All of these are load()-side parameters; setup() body is byte-identical to PB-DIO.

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

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/dio/dioload.c` line-for-line, stamping through cached handles. No allocElement calls.

- Preserve multiplicity scaling: all current and conductance stamps are multiplied by the instance `M` parameter (default 1.0). ngspice anchor: `dioload.c` / `mos1load.c` / `bjtload.c` / `jfetload.c` use `here->{DIO|MOS1|BJT|JFET}m` for this scaling. The instance `M` parameter is partition: "instance" per the in-progress phase-instance-vs-model-param-partition work.

## findBranchFor (if applicable)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { A: "pos", K: "neg" }`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-SCHOTTKY is GREEN.
2. Implementer creates `src/components/semiconductors/__tests__/schottky.test.ts` (the file does not currently exist) and the file is GREEN. Required assertions:

   - Forward voltage: a Schottky diode with default params, biased at I=1mA forward, settles at V_F between 0.20V and 0.40V (matches typical Schottky barrier physics — lower than silicon's ~0.7V).
   - RS-conditional internal node: when `RS > 0`, the diode allocates an internal posPrime node (verified by walking `_setup()` output and asserting one extra `makeVolt` call); when `RS = 0`, no internal node is allocated.
   - TSTALLOC ordering: `solver._getInsertionOrder()` after `_setup()` returns the diode's TSTALLOC sequence in the same order as `dio/diosetup.c` (4 entries when RS=0; 7 entries when RS>0).
   - Pattern after `src/components/semiconductors/__tests__/diode.test.ts` — reuse helpers and circuit-build patterns.

   The test file's existence and GREEN status is the W3 verification gate for PB-SCHOTTKY.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
