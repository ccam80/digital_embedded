# Task PB-TRIODE

**digiTS file:** `src/components/semiconductors/triode.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/vccs/vccsset.c:43-46`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/vccs/vccsload.c` (structure only — Koren transconductance overrides value)

## Pin mapping (from 01-pin-mapping.md)

Triode is a **composite** — it does not stamp into the matrix directly.
It decomposes into 1× VCCS sub-element with Koren-style transconductance.

| digiTS parent label | Parent pin | Sub-element assignment | ngspice VCCS variable |
|---|---|---|---|
| `P` | Plate | `posNode` (output+) | `VCCSposNode` |
| `G` | Grid | `contPosNode` (control+) | `VCCScontPosNode` |
| `K` | Kathode | `negNode` (output-) AND `contNegNode` (control-) | `VCCSnegNode` = `VCCScontNegNode` |

The grid-to-cathode voltage V(G,K) is the controlling voltage.
The plate current I(P→K) is the output current.
The cathode is simultaneously the output minus and the control minus.

## Sub-element specification

### Sub-element 1: VCCS `vccs_triode`

| Field | Value |
|---|---|
| Class | The existing VCCS analog element class |
| Label | `${parentLabel}#vccs` |
| `contPosNode` | `pinNodes.get("G")!` |
| `contNegNode` | `pinNodes.get("K")!` |
| `posNode` | `pinNodes.get("P")!` |
| `negNode` | `pinNodes.get("K")!` |
| `ngspiceNodeMap` | `{ "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }` |
| Static `G` param | Not used — plate current computed dynamically in load() via Koren formula |

### setParam routing rule

`setParam(key, value)` on the parent Triode forwards Koren model parameters to
the sub-element for storage only (not used by generic VCCS load; used by the
Triode-specific load override):

| Param | Meaning |
|---|---|
| `MU` | Amplification factor |
| `EX` | Koren exponent |
| `KG1` | Conductance parameter |
| `KG2` | Screen conductance parameter (if pentode-style) |
| `KP` | Koren KP parameter |
| `KVB` | Koren KVB parameter |
| `VCT` | Cathode characteristic voltage |

These are forwarded to the VCCS sub-element via its own `setParam`. The
Triode's load() reads them back from the sub-element's parameter store.

## Internal nodes

None. The VCCS sub-element has no internal nodes (vccsset.c has no CKTmkVolt
calls).

## Branch rows

None. VCCS has no branch row.

## State slots

VCCS: `NG_IGNORE(states)` — zero states allocated.

```ts
// No ctx.allocStates call.
```

## TSTALLOC sequence (line-for-line port)

`vccsset.c:43-46`. Four entries. Port is inside the VCCS sub-element's own
setup().

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `VCCSposContPosptr` | `VCCSposNode` | `VCCScontPosNode` | `this._hPosCPos` |
| 2 | `VCCSposContNegptr` | `VCCSposNode` | `VCCScontNegNode` | `this._hPosCNeg` |
| 3 | `VCCSnegContPosptr` | `VCCSnegNode` | `VCCScontPosNode` | `this._hNegCPos` |
| 4 | `VCCSnegContNegptr` | `VCCSnegNode` | `VCCScontNegNode` | `this._hNegCNeg` |

With the Triode's node assignments (`posNode=P`, `negNode=K`, `contPosNode=G`,
`contNegNode=K`):

| # | Effective call | Handle |
|---|---|---|
| 1 | `allocElement(P, G)` | `this._hPosCPos` |
| 2 | `allocElement(P, K)` | `this._hPosCNeg` |
| 3 | `allocElement(K, G)` | `this._hNegCPos` |
| 4 | `allocElement(K, K)` | `this._hNegCNeg` |

Note: entries (2) and (4) share `K` as both row and column — `allocElement(P,K)`
and `allocElement(K,K)` are distinct positions. No collapse beyond what
`allocElement` handles idempotently for the (K,K) diagonal.

## setup() body — alloc only

```ts
// Triode composite setup()
setup(ctx: SetupContext): void {
  this._vccs.setup(ctx);   // forwards to VccsAnalogElement.setup() — 4 entries
  const solver = ctx.solver;
  const nP = this._vccs._posNode;  // plate node
  const nK = this._vccs._negNode;  // cathode node

  // gds stamps — 2 additional entries (6 total for Triode).
  // Triode setup() unconditionally allocates 6 entries (4 VCCS + 2 gds, gds always nonzero per Koren formula).
  this._hPP_gds = solver.allocElement(nP, nP);  // (plate, plate)
  this._hKP_gds = solver.allocElement(nK, nP);  // (cathode, plate)
}
```

Fields to add to `TriodeElement`:
```ts
private _hPP_gds: number = -1;
private _hKP_gds: number = -1;
```

The VccsAnalogElement.setup() for this instance (P=plate, G=grid, K=cathode):

```ts
// VccsAnalogElement.setup() — Triode binding
setup(ctx: SetupContext): void {
  const solver      = ctx.solver;
  const posNode     = this._posNode;      // P (plate)
  const negNode     = this._negNode;      // K (cathode)
  const contPosNode = this._contPosNode;  // G (grid)
  const contNegNode = this._contNegNode;  // K (cathode)

  // TSTALLOC sequence — vccsset.c:43-46
  this._hPosCPos = solver.allocElement(posNode, contPosNode); // (1) P, G
  this._hPosCNeg = solver.allocElement(posNode, contNegNode); // (2) P, K
  this._hNegCPos = solver.allocElement(negNode, contPosNode); // (3) K, G
  this._hNegCNeg = solver.allocElement(negNode, contNegNode); // (4) K, K
}
```

## load() body — value writes only

The parent Triode composite `load()` computes the Koren plate-current
equation at the current operating point V(G,K) and V(P,K), then stamps
through the VCCS sub-element's cached handles using the linearized
conductance and Norton current:

**Koren plate current formula:**

```
E1  = Vgk + MU * sqrt(KVB + Vpk^2) + Vpk) / KP
Ip  = (2/KG1) * E1^EX * (1 + sign(E1))   [when E1 > 0]
gm  = dIp/dVgk   (partial derivative wrt grid voltage)
gds = dIp/dVpk   (partial derivative wrt plate voltage)
```

Stamps via the 4 VCCS handles plus 2 composite-owned gds handles:

```
// Transconductance gm stamps (ctrl+ = G, ctrl- = K):
solver.stampElement(_hPosCPos, +gm)   // (P,G): +gm
solver.stampElement(_hPosCNeg, -gm)   // (P,K): -gm
solver.stampElement(_hNegCPos, -gm)   // (K,G): -gm
solver.stampElement(_hNegCNeg, +gm)   // (K,K): +gm

// Output conductance gds stamps (composite-owned handles allocated in setup()):
ctx.solver.stampElement(this._hPP_gds, +gds);  // (P,P): +gds
ctx.solver.stampElement(this._hKP_gds, -gds);  // (K,P): -gds
```

**RHS Norton current:**

```
ieq = Ip - gm * Vgk - gds * Vpk
stampRHS(P, -ieq)
stampRHS(K, +ieq)
```

No allocElement calls in load().

## findBranchFor (if applicable)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- `mayCreateInternalNodes` omitted (false).
- Composite does not carry `ngspiceNodeMap` — the VCCS sub-element carries its own.

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
