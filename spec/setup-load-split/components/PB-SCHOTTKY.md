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

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body — alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only — zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
