# Task PB-POLCAP

**digiTS file:** `src/components/passives/polarized-cap.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/cap/capsetup.c:102-117` (delegated — polarized cap IS a capacitor with additional topology)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/cap/capload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { pos: "pos", neg: "neg" }` (delegated to CAP sub-element).

The PolarizedCap composite does not get its own `ngspiceNodeMap` on `ComponentDefinition` — it decomposes into a CAP sub-element (plus ESR RES, leakage RES, and clamp DIO sub-elements), and each sub-element carries its own map.

## Internal nodes

The polarized cap creates one internal node `n_cap` (junction between ESR and the capacitor body). This is allocated by the composite's `setup()` via `ctx.makeVolt`, not via the capacitor's inherited setup.

```
pos ─── ESR ─── n_cap ─── (C || leakage) ─── neg
```

`mayCreateInternalNodes: true` must be set on the `MnaModel` entry.

## Branch rows

None (no `CKTmkCur` calls).

## State slots

The composite calls `ctx.allocStates` for its pool-backed state. Current implementation has `stateSize = POLARIZED_CAP_SCHEMA.size + CLAMP_DIODE_STATE_SIZE` = 9 slots. After the setup/load split, state allocation moves to `setup()`:

```ts
this._stateBase = ctx.allocStates(this.stateSize);  // 9 slots total
```

## TSTALLOC sequence (line-for-line port)

The PolarizedCap composite is NOT a direct ngspice primitive — it has no matching single `*setup.c`. Its TSTALLOC stamps come from its sub-elements:

**ESR RES** (`ressetup.c:46-49` pattern, pos ↔ n_cap):

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(posNode, posNode)` | `_hESR_PP` |
| 2 | `(RESnegNode, RESnegNode)` | `(nCap, nCap)` | `_hESR_NN` |
| 3 | `(RESposNode, RESnegNode)` | `(posNode, nCap)` | `_hESR_PN` |
| 4 | `(RESnegNode, RESposNode)` | `(nCap, posNode)` | `_hESR_NP` |

**Leakage RES** (`ressetup.c:46-49` pattern, n_cap ↔ neg):

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 5 | `(RESposNode, RESposNode)` | `(nCap, nCap)` | `_hLEAK_PP` |
| 6 | `(RESnegNode, RESnegNode)` | `(negNode, negNode)` | `_hLEAK_NN` |
| 7 | `(RESposNode, RESnegNode)` | `(nCap, negNode)` | `_hLEAK_PN` |
| 8 | `(RESnegNode, RESposNode)` | `(negNode, nCap)` | `_hLEAK_NP` |

**Clamp DIO** (`diosetup.c` pattern, anode = negNode, cathode = posNode — reverse-mounted clamp):

Clamp diode TSTALLOC sequence inlined here for self-containment (mirrors PB-DIO §setup() body for the standalone DIO).

The clamp diode has an internal `posPrime_clamp` node (DIO cathode-side ohmic resistance junction). Polarity-reverse rule: anode = `negNode`, cathode = `posNode`.

| # | ngspice pointer | digiTS pair | handle field |
|---|---|---|---|
| 5 | `DIOposPrimePosPrimePtr` | `(posPrime_clamp, posPrime_clamp)` | `_hDIO_PP_clamp` |
| 6 | `DIOnegNegPtr` | `(negNode, negNode)` | `_hDIO_NN_clamp` |
| 7 | `DIOposPrimeNegPtr` | `(posPrime_clamp, negNode)` | `_hDIO_PN_clamp` |
| 8 | `DIOnegPosPrimePtr` | `(negNode, posPrime_clamp)` | `_hDIO_NP_clamp` |

The clamp diode sub-element's `setup()` allocates these handles and stores `posPrime_clamp` via `ctx.makeVolt`.

**CAP body** (`capsetup.c:114-117` pattern, n_cap ↔ neg):

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 9 | `(CAPposNode, CAPposNode)` | `(nCap, nCap)` | `_hCAP_PP` |
| 10 | `(CAPnegNode, CAPnegNode)` | `(negNode, negNode)` | `_hCAP_NN` |
| 11 | `(CAPposNode, CAPnegNode)` | `(nCap, negNode)` | `_hCAP_PN` |
| 12 | `(CAPnegNode, CAPposNode)` | `(negNode, nCap)` | `_hCAP_NP` |

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this._pinNodes.get("pos")!;  // pos pin
  const negNode = this._pinNodes.get("neg")!;  // neg pin

  // Allocate internal node n_cap (junction between ESR and cap body).
  // No ngspice primitive equivalent — digiTS-internal topology extension.
  const nCap = ctx.makeVolt(this._label, "cap");
  this._nCap = nCap;

  // State slots — 9 total (5 cap body + 4 clamp diode).
  this._stateBase = ctx.allocStates(this.stateSize);

  // ESR RES stamps (ressetup.c:46-49, pos ↔ nCap).
  this._hESR_PP = solver.allocElement(posNode, posNode);
  this._hESR_NN = solver.allocElement(nCap,    nCap);
  this._hESR_PN = solver.allocElement(posNode, nCap);
  this._hESR_NP = solver.allocElement(nCap,    posNode);

  // Leakage RES stamps (ressetup.c:46-49, nCap ↔ neg).
  this._hLEAK_PP = solver.allocElement(nCap,    nCap);
  this._hLEAK_NN = solver.allocElement(negNode, negNode);
  this._hLEAK_PN = solver.allocElement(nCap,    negNode);
  this._hLEAK_NP = solver.allocElement(negNode, nCap);

  // Clamp diode sub-element setup (diosetup.c pattern, anode=neg, cathode=pos).
  this._clampDiode.setup(ctx);

  // CAP body stamps (capsetup.c:114-117, nCap ↔ neg).
  this._hCAP_PP = solver.allocElement(nCap,    nCap);
  this._hCAP_NN = solver.allocElement(negNode, negNode);
  this._hCAP_PN = solver.allocElement(nCap,    negNode);
  this._hCAP_NP = solver.allocElement(negNode, nCap);
}
```

Fields to add to `AnalogPolarizedCapElement`:
```ts
private _nCap: number = -1;
private _stateBase: number = -1;
private _hESR_PP: number = -1;      private _hESR_NN: number = -1;
private _hESR_PN: number = -1;      private _hESR_NP: number = -1;
private _hLEAK_PP: number = -1;     private _hLEAK_NN: number = -1;
private _hLEAK_PN: number = -1;     private _hLEAK_NP: number = -1;
private _hDIO_PP_clamp: number = -1; private _hDIO_NN_clamp: number = -1;
private _hDIO_PN_clamp: number = -1; private _hDIO_NP_clamp: number = -1;
private _hCAP_PP: number = -1;      private _hCAP_NN: number = -1;
private _hCAP_PN: number = -1;      private _hCAP_NP: number = -1;
```

The clamp diode sub-element is constructed at factory time (not setup time), so it exists before `setup()` is called.

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/cap/capload.c` line-for-line for the CAP body stamps, stamping through cached handles only. ESR and leakage conductance stamps also use cached handles. The clamp diode sub-element's `load()` is called via `this._clampDiode.load(ctx)`. No `solver.allocElement` calls anywhere in `load()`.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createPolarizedCapElement` factory signature (per A6.3). The internal node `n_cap` is allocated in `setup()`, not passed from the compiler.
- Remove `getInternalNodeCount: 1` from `MnaModel` registration (per A6.2).
- Add `mayCreateInternalNodes: true` to `MnaModel` registration (creates `n_cap` in setup).
- The composite `ComponentDefinition` leaves `ngspiceNodeMap` undefined (composite decomposes — sub-elements carry their own maps).
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
