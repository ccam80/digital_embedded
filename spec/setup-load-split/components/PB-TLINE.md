# Task PB-TLINE

**digiTS file:** `src/components/passives/transmission-line.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/tra/trasetup.c:37-92`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/tra/traload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { P1a: "posNode1", P1b: "negNode1", P2a: "posNode2", P2b: "negNode2" }`.

| digiTS pin label | pinNodes key | ngspice node variable |
|---|---|---|
| `P1a` | `pinNodes.get("P1a")` | `TRAposNode1` |
| `P1b` | `pinNodes.get("P1b")` | `TRAnegNode1` |
| `P2a` | `pinNodes.get("P2a")` | `TRAposNode2` |
| `P2b` | `pinNodes.get("P2b")` | `TRAnegNode2` |

**Note on pin layout vs ngspice anchor:** The digiTS transmission line uses a lumped RLCG model (N cascaded segments) rather than the ngspice ideal lossless TRA model. The ngspice `trasetup.c` anchor provides the reference for the TSTALLOC ordering for a single ideal segment. The digiTS composite creates `N` segments with internal nodes per segment, each following the inductor TSTALLOC pattern internally. See the Port Error note below.

## Port Error

**Structural divergence from ngspice TRA model that must be escalated before W3 implementation proceeds:**

The digiTS `TransmissionLineElement` is a lumped RLCG model (N cascaded RLC segments), not an ideal lossless transmission line as implemented by `trasetup.c`. The ngspice TRA model:
- Allocates exactly 4 internal nodes (`TRAbrEq1`, `TRAbrEq2`, `TRAintNode1`, `TRAintNode2`) regardless of length or parameters (trasetup.c:37-59).
- Uses 22 unconditional TSTALLOC stamps (trasetup.c:71-92).
- The TSTALLOC sequence is fixed and paramater-independent.

The digiTS model:
- Allocates `2*(N-1)` internal nodes and `N` branch rows, where `N = segments` parameter (default 10).
- Each of the N inductor sub-elements has 5 TSTALLOC stamps (following indsetup.c:96-100).
- Each of the N-1 capacitor sub-elements has 4 TSTALLOC stamps (following capsetup.c:114-117).
- The total TSTALLOC count is `5*N + 4*(N-1)` = `9N - 4`, which for N=10 is 86 stamps.
- This is architecturally different from trasetup.c's 22 stamps.

**Consequence for setup-stamp-order.test.ts:** The test row for PB-TLINE cannot assert a fixed 22-entry sequence matching trasetup.c lines 71-92. The correct assertion is: per-sub-element ordering is maintained (each SegmentInductorElement follows indsetup.c:96-100; each SegmentCapacitorElement follows capsetup.c:114-117), with the sub-elements stamped in segment order (R₀, L₀, G₀/C₀, R₁, L₁, G₁/C₁, ..., RL_{N-1}).

**This divergence is architectural and must be recorded in `spec/architectural-alignment.md` before any W3 agent implements PB-TLINE.** Do not proceed with implementation without user approval of the architectural record. The user action required: add an entry to `spec/architectural-alignment.md` documenting that digiTS uses lumped RLCG (N segments) instead of the ideal lossless TRA model, with the explicit ngspice file (`trasetup.c`), the digiTS file (`transmission-line.ts`), and the quantity difference (22 fixed stamps vs 9N-4 parameterized stamps).

---

The following sections document what the setup() body WOULD look like for the lumped model, assuming the architectural divergence is approved.

## Internal nodes

For N segments, `2*(N-1)` internal nodes:
- `rlMid[k]` for k=0..N-2: RL mid-nodes (between series R and series L in each non-final segment)
- `junc[k]` for k=0..N-2: junction nodes (output of each non-final segment's L, where shunt G/C attach)

Allocated in `setup()` via `N-1` calls to `ctx.makeVolt(label, "rlMid{k}")` and `N-1` calls to `ctx.makeVolt(label, "junc{k}")`.

## Branch rows

N branch rows (one per inductor sub-element), allocated via `ctx.makeCur(label, "ibr{k}")` for k=0..N-1.

## State slots

State slots allocated per reactive sub-element:
- Each `SegmentInductorElement`: `ctx.allocStates(2)` (PHI + CCAP, per indsetup.c:78-79)
- Each `SegmentCapacitorElement`: `ctx.allocStates(2)` (Q + CCAP, per capsetup.c:102-103)
- Each `CombinedRLElement`: `ctx.allocStates(2)` (PHI + CCAP)

Total: `2*N + 2*(N-1)` = `4N - 2` state slots for N=10: 38 slots.

## TSTALLOC sequence (line-for-line port)

Per-sub-element ordering, in segment iteration order k=0..N-1:

**For segment k < N-1** (non-final segments):

SegmentResistorElement (k) — ressetup.c:46-49 pattern (inputNode ↔ rlMid[k]):
| `(inputNode, inputNode)` | `_hR[k]_PP` |
| `(rlMid[k], rlMid[k])` | `_hR[k]_NN` |
| `(inputNode, rlMid[k])` | `_hR[k]_PN` |
| `(rlMid[k], inputNode)` | `_hR[k]_NP` |

SegmentInductorElement (k) — indsetup.c:96-100 pattern (rlMid[k] ↔ junc[k], ibr[k]):
| `(rlMid[k], ibr[k])` | `_hL[k]_PIbr` |
| `(junc[k], ibr[k])` | `_hL[k]_NIbr` |
| `(ibr[k], junc[k])` | `_hL[k]_IbrN` |
| `(ibr[k], rlMid[k])` | `_hL[k]_IbrP` |
| `(ibr[k], ibr[k])` | `_hL[k]_IbrIbr` |

SegmentCapacitorElement (k) — capsetup.c:114-117 pattern (junc[k] ↔ gnd=0):
| `(junc[k], junc[k])` | `_hC[k]_PP` |
(ground-skipped entries omitted; junc[k]↔0 means only the (junc[k],junc[k]) entry is non-ground)

**For segment N-1** (final segment — CombinedRLElement):

CombinedRLElement — indsetup.c:96-100 pattern (junc[N-2] ↔ port2, ibr[N-1]):
| `(junc[N-2], ibr[N-1])` | `_hCRL_PIbr` |
| `(port2, ibr[N-1])` | `_hCRL_NIbr` |
| `(ibr[N-1], junc[N-2])` | `_hCRL_IbrP` |
| `(ibr[N-1], port2)` | `_hCRL_IbrN` |
| `(ibr[N-1], ibr[N-1])` | `_hCRL_IbrIbr` |

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const port1 = pinNodes.get("P1b")!;  // TRAnegNode1 (digiTS: positive rail port 1)
  const port2 = pinNodes.get("P2b")!;  // TRAnegNode2 (digiTS: positive rail port 2)
  const N = this._segments;

  // Allocate internal nodes: rlMid[0..N-2] then junc[0..N-2]
  // trasetup.c:49-59 pattern (CKTmkVolt for internal nodes).
  const rlMidNodes: number[] = [];
  const juncNodes: number[] = [];
  for (let k = 0; k < N - 1; k++) {
    rlMidNodes.push(ctx.makeVolt(this._label, `rlMid${k}`));
    juncNodes.push(ctx.makeVolt(this._label, `junc${k}`));
  }

  // Allocate branch rows and matrix elements for each sub-element.
  // indsetup.c:78-88 / capsetup.c:102-103 patterns applied per sub-element.
  for (let k = 0; k < N; k++) {
    const inputNode = k === 0 ? port1 : juncNodes[k - 1];
    const brIdx = ctx.makeCur(this._label, `ibr${k}`);
    this._subElements[k].setup(ctx);  // delegates to sub-element's own setup()
  }

  // State slot allocation happens inside each sub-element's setup() call.
}
```

Note: The composite forwards `setup(ctx)` to each sub-element in order. Each `SegmentInductorElement`, `SegmentCapacitorElement`, and `CombinedRLElement` implements its own `setup()` following the patterns specified in PB-IND and PB-CAP respectively.

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/tra/traload.c` (ideal TRA reference) and `ref/ngspice/src/spicelib/devices/ind/indload.c` / `ref/ngspice/src/spicelib/devices/cap/capload.c` (for RLCG sub-elements), stamping through cached handles only. No `solver.allocElement` calls.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from `createTransmissionLineElement` factory signature (per A6.3). Internal nodes and branch rows allocated in `setup()`.
- Remove `branchCount`, `getInternalNodeCount`, `getInternalNodeLabels` from `MnaModel` registration (per A6.2).
- Add `hasBranchRow: true` (N branch rows per instance).
- Add `mayCreateInternalNodes: true`.
- The `ComponentDefinition` leaves `ngspiceNodeMap` undefined (composite decomposes — sub-elements carry their own maps per segment).
- No `findBranchFor` callback needed at the composite level (sub-element inductors expose their own `findBranchFor` via the sub-element registry if needed).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-TLINE is GREEN (per-sub-element ordering verified for N=2 minimal case).
2. Transmission line test file is GREEN.
3. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence) used in any commit message or report.
4. **Prerequisite:** Architectural divergence entry exists in `spec/architectural-alignment.md` before implementation begins.
