# Task PB-TUNNEL

**digiTS file:** `src/components/semiconductors/tunnel-diode.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/vccs/vccsset.c:43-46`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/vccs/vccsload.c` (structure only- tunnel I-V curve overrides value)

## Pin mapping (from 01-pin-mapping.md)

TunnelDiode is a **composite**- it does not stamp into the matrix directly.
It decomposes into 1× VCCS sub-element.

| digiTS parent label | Parent pin | Sub-element assignment | ngspice VCCS variable |
|---|---|---|---|
| `A` | Anode | `contPosNode` AND `posNode` (output+) | `VCCScontPosNode` = `VCCSposNode` |
| `K` | Kathode | `contNegNode` AND `negNode` (output-) | `VCCScontNegNode` = `VCCSnegNode` |

The controlling pair (A, K) is the same as the output pair (A, K). This is a
self-controlled VCCS: `I(A→K) = f(V_AK)`.

## Sub-element specification

### Sub-element 1: VCCS `vccs_tunnel`

| Field | Value |
|---|---|
| Class | The existing VCCS analog element class (same as `src/components/active/vccs.ts` model) |
| Label | `${parentLabel}#vccs` |
| Construction | `new VccsAnalogElement(label, pinNodes, props, getTime)` |
| `contPosNode` | `pinNodes.get("A")!` |
| `contNegNode` | `pinNodes.get("K")!` |
| `posNode` | `pinNodes.get("A")!` |
| `negNode` | `pinNodes.get("K")!` |
| `ngspiceNodeMap` | `{ "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }` |
| `setParam` routing | All params forwarded unchanged; `G` (transconductance) is NOT a static param- the tunnel I-V function produces a dynamic linearized `g` each load() iteration |

### setParam routing rule

`setParam(key, value)` on the parent TunnelDiode forwards to the sub-element only
for physical model params (`IS`, `IP`, `VP`, `VV`, `IV`, `A`, `B`, `C`- the
Esaki/Zetex tunnel model parameters). The VCCS `G` field is **not** a static
setParam target; it is computed dynamically in load().

## Internal nodes

None. The VCCS sub-element has no internal nodes (vccsset.c has no CKTmkVolt calls).

## Branch rows

None. VCCS has no branch row.

## State slots

VCCS setup: `NG_IGNORE(states)` at vccsset.c:27- zero states allocated.

```ts
// No ctx.allocStates call.
```

## TSTALLOC sequence (line-for-line port)

`vccsset.c:43-46`. Four entries. Port is inside the VCCS sub-element's own setup().

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `VCCSposContPosptr` | `VCCSposNode` | `VCCScontPosNode` | `this._hPCtP` |
| 2 | `VCCSposContNegptr` | `VCCSposNode` | `VCCScontNegNode` | `this._hPCtN` |
| 3 | `VCCSnegContPosptr` | `VCCSnegNode` | `VCCScontPosNode` | `this._hNCtP` |
| 4 | `VCCSnegContNegptr` | `VCCSnegNode` | `VCCScontNegNode` | `this._hNCtN` |

Because `posNode = contPosNode = pinNodes.get("A")` and
`negNode = contNegNode = pinNodes.get("K")`, all four entries collapse to
the four corners of the 2×2 (A,K) sub-matrix:

| # | Effective call | Handle |
|---|---|---|
| 1 | `allocElement(A, A)` | `this._hPCtP` |
| 2 | `allocElement(A, K)` | `this._hPCtN` |
| 3 | `allocElement(K, A)` | `this._hNCtP` |
| 4 | `allocElement(K, K)` | `this._hNCtN` |

`allocElement` is idempotent; repeated (A,A) or (K,K) calls return the existing
handle. No special case in the port.

## setup() body- alloc only

The parent TunnelDiode composite `setup()` forwards to the sub-element:

```ts
// TunnelDiode composite setup()
setup(ctx: SetupContext): void {
  this._vccs.setup(ctx);   // forwards to VccsAnalogElement.setup()
}
```

VccsAnalogElement.setup() body: see PB-VCCS.md sssetup() body- this composite forwards directly to that body via this._vccs.setup(ctx).

## load() body- value writes only

The parent TunnelDiode composite `load()` computes the tunnel I-V function at
the current operating point `V_AK`, then stamps through the VCCS sub-element's
cached handles using the linearized conductance and Norton current:

```
I(V_AK)    = tunnel_iv_curve(V_AK)    // Esaki/Zetex formula
g(V_AK)    = dI/dV_AK                  // linearized conductance
ieq         = I(V_AK) - g * V_AK       // Norton equivalent
```

Destructure the VCCS sub-element's TSTALLOC handles once at the top of `load()`
via the readonly `stamps` accessor (see PB-VCCS ss "VccsAnalogElement.stamps-
readonly accessor for composite users"):

```ts
const { pCtP, pCtN, nCtP, nCtN } = this._vccs.stamps;
```

Stamps:
- `solver.stampElement(pCtP, +g)`
- `solver.stampElement(pCtN, -g)`
- `solver.stampElement(nCtP, -g)`
- `solver.stampElement(nCtN, +g)`
- RHS stamps for Norton current `ieq` at nodes A and K.

No allocElement calls.

Implementer ports the tunnel I-V curve computation (`IS`, `IP`, `VP`, `VV`, `IV`,
`A`, `B`, `C` params) from the existing `tunnel-diode.ts` load body into the
new load() method structure.

## findBranchFor (if applicable)

Not applicable. VCCS has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- `mayCreateInternalNodes` omitted (false).
- Composite does not carry `ngspiceNodeMap`- the VCCS sub-element carries its own.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body- alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only- zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
