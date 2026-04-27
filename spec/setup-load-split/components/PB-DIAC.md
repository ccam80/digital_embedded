# Task PB-DIAC

**digiTS file:** `src/components/semiconductors/diac.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/dio/diosetup.c:198-238` (per sub-element)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/dio/dioload.c` (per sub-element)

## Pin mapping (from 01-pin-mapping.md)

DIAC is a **composite** — it does not stamp into the matrix directly.
It decomposes into 2× DIO sub-elements (antiparallel, both with breakdown).

| digiTS parent label | Parent pin | Role |
|---|---|---|
| `A` | Terminal A | Anode of D_fwd; Cathode of D_rev |
| `B` | Terminal B | Cathode of D_fwd; Anode of D_rev |

## Sub-element specification

### Sub-element 1: DIO `D_fwd` — forward diode (A→B)

| Field | Value |
|---|---|
| Class | Diode analog element (same class as `src/components/semiconductors/diode.ts` model) |
| Label | `${parentLabel}#D_fwd` |
| Anode (`DIOposNode`) | `pinNodes.get("A")!` |
| Cathode (`DIOnegNode`) | `pinNodes.get("B")!` |
| `ngspiceNodeMap` | `{ A: "pos", B: "neg" }` (A=anode maps to pos, B=cathode maps to neg) |
| Breakdown enabled | Yes — `BV` set to DIAC breakover voltage (e.g. 30 V) |
| `RS` | As per DIAC model (small series resistance) |

### Sub-element 2: DIO `D_rev` — reverse diode (B→A, antiparallel)

| Field | Value |
|---|---|
| Class | Diode analog element (same class as `src/components/semiconductors/diode.ts` model) |
| Label | `${parentLabel}#D_rev` |
| Anode (`DIOposNode`) | `pinNodes.get("B")!` |
| Cathode (`DIOnegNode`) | `pinNodes.get("A")!` |
| `ngspiceNodeMap` | `{ B: "pos", A: "neg" }` (B=anode maps to pos, A=cathode maps to neg) |
| Breakdown enabled | Yes — same `BV` as D_fwd |
| `RS` | Same as D_fwd |

The two diodes are electrically antiparallel: D_fwd conducts for positive
V(A,B); D_rev conducts for negative V(A,B). Breakdown fires in reverse for
each diode — for D_fwd when V(B,A) > BV, for D_rev when V(A,B) > BV.
Together they implement the DIAC's symmetric bidirectional breakover.

### setParam routing rule

`setParam(key, value)` on the parent DIAC forwards the same value to BOTH
sub-elements for shared model parameters (`BV`, `IBV`, `IS`, `N`, `RS`).
The sub-elements are symmetric by design; no asymmetric routing is needed.

## Internal nodes

Each sub-element may create one internal node when its `RS ≠ 0`:

- `D_fwd._posPrimeNode`: internal between A and the DIO junction (when RS ≠ 0)
- `D_rev._posPrimeNode`: internal between B and the DIO junction (when RS ≠ 0)

Managed by each sub-element's own `setup()` — the parent DIAC composite does
not call `ctx.makeVolt()` directly.

### RS=0 alias rule (per ngspice `dio/diosetup.c:204-208`)

When the diode model has `RS = 0`, ngspice sets `DIOposPrimeNode = DIOposNode`
directly — no internal node is allocated via `CKTmkVolt`. When `RS > 0` (and
`DIOposPrimeNode == 0`, i.e. not yet allocated), ngspice calls
`CKTmkVolt(ckt, &tmp, here->DIOname, "internal")` to create a private internal
node and stores its number on `DIOposPrimeNode`.

Translation to digiTS for D_fwd / D_rev sub-elements:

- If `this._params.RS === 0`: skip the `ctx.makeVolt(this._label, "posPrime")`
  call. Set `this._posPrimeNode = posNode` (the external positive pin's node
  ID, taken from `pinNodes.get("A")` for D_fwd or `pinNodes.get("B")` for
  D_rev). The 4 TSTALLOC entries that reference posPrimeNode then degenerate:
  `(posPrime, posPrime) → (pos, pos)`, `(posPrime, neg) → (pos, neg)`,
  `(pos, posPrime) → (pos, pos)`, `(neg, posPrime) → (neg, pos)`. The two
  `(pos, pos)` entries collapse to the same handle (`allocElement` is
  idempotent on identical row/col pairs per 00-engine.md §A6 — confirm with
  the engine spec).
- If `this._params.RS > 0`: call
  `this._posPrimeNode = ctx.makeVolt(this._label, "posPrime")` and allocate
  the full TSTALLOC sequence with the distinct internal node.

The setup() body code block (if present) for each sub-element branches on
`RS === 0` and emits the appropriate alloc sequence.

## Branch rows

None (neither DIO sub-element has a branch row).

## State slots

Each DIO sub-element allocates 5 state slots independently:

```ts
// Inside D_fwd.setup(ctx): ctx.allocStates(5)  → offset_fwd
// Inside D_rev.setup(ctx): ctx.allocStates(5)  → offset_rev
```

Total for DIAC instance: 10 state slots (2 × 5). Allocated in sub-element
setup() order (D_fwd first, then D_rev).

## TSTALLOC sequence (line-for-line port)

Each sub-element follows the 7-entry DIO TSTALLOC sequence from
`diosetup.c:232-238` independently. The parent composite's `setup()` simply
forwards to both in order.

**D_fwd (posNode=A, negNode=B, posPrimeNode=A or internal_fwd):**

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `DIOposPosPrimePtr` | A | posPrime_fwd | `D_fwd._hPosPP` |
| 2 | `DIOnegPosPrimePtr` | B | posPrime_fwd | `D_fwd._hNegPP` |
| 3 | `DIOposPrimePosPtr` | posPrime_fwd | A | `D_fwd._hPPPos` |
| 4 | `DIOposPrimeNegPtr` | posPrime_fwd | B | `D_fwd._hPPNeg` |
| 5 | `DIOposPosPtr` | A | A | `D_fwd._hPosPos` |
| 6 | `DIOnegNegPtr` | B | B | `D_fwd._hNegNeg` |
| 7 | `DIOposPrimePosPrimePtr` | posPrime_fwd | posPrime_fwd | `D_fwd._hPPPP` |

**D_rev (posNode=B, negNode=A, posPrimeNode=B or internal_rev):**

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `DIOposPosPrimePtr` | B | posPrime_rev | `D_rev._hPosPP` |
| 2 | `DIOnegPosPrimePtr` | A | posPrime_rev | `D_rev._hNegPP` |
| 3 | `DIOposPrimePosPtr` | posPrime_rev | B | `D_rev._hPPPos` |
| 4 | `DIOposPrimeNegPtr` | posPrime_rev | A | `D_rev._hPPNeg` |
| 5 | `DIOposPosPtr` | B | B | `D_rev._hPosPos` |
| 6 | `DIOnegNegPtr` | A | A | `D_rev._hNegNeg` |
| 7 | `DIOposPrimePosPrimePtr` | posPrime_rev | posPrime_rev | `D_rev._hPPPP` |

Note: D_fwd entry (6) `allocElement(B,B)` and D_rev entry (5) `allocElement(B,B)`
are the same call — `allocElement` returns the existing handle on the second call.
Similarly D_fwd entry (5) `allocElement(A,A)` and D_rev entry (6) `allocElement(A,A)`.

## setup() body — alloc only

```ts
// DIAC composite setup()
setup(ctx: SetupContext): void {
  this._dFwd.setup(ctx);   // D_fwd: DIO with posNode=A, negNode=B
  this._dRev.setup(ctx);   // D_rev: DIO with posNode=B, negNode=A
}
```

Each sub-element's `setup()` is the full PB-DIO `setup()` body with its
respective node assignments.

## load() body — value writes only

```ts
// DIAC composite load()
load(ctx: LoadContext): void {
  this._dFwd.load(ctx);
  this._dRev.load(ctx);
}
```

Each sub-element ports its load from `dioload.c` independently, including the
breakdown branch, stamping through its own cached handles.

## findBranchFor (if applicable)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true` (sub-elements may create internal nodes).
- Composite does not carry `ngspiceNodeMap` — sub-elements carry their own.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-DIAC is GREEN (verifies D_fwd then D_rev TSTALLOC order).
2. `src/components/semiconductors/__tests__/diac.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
