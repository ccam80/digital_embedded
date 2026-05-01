# Task PB-TLINE- Lumped RLCG transmission line (Option A)

**digiTS file:** `src/components/passives/transmission-line.ts`
**Composite class:** `TransmissionLineElement`
**Inline sub-element classes (kept verbatim, only setup() bodies added):**
- `SegmentResistorElement` (linear R, 4 TSTALLOC entries)
- `SegmentInductorElement` (linear L with branch row, 5 TSTALLOC entries)
- `SegmentShuntConductanceElement` (single-handle stamp to ground, 1 TSTALLOC entry)
- `SegmentCapacitorElement` (single-handle stamp to ground, 1 TSTALLOC entry)
- `CombinedRLElement` (digiTS-internal R+L combined, no ngspice anchor; final segment only)

**ngspice setup anchors:**
- `SegmentResistorElement`: `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49`
- `SegmentInductorElement`: `ref/ngspice/src/spicelib/devices/ind/indsetup.c:78-100`
- `SegmentShuntConductanceElement`: `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49` (collapsed to single (n,n)- one terminal is ground)
- `SegmentCapacitorElement`: `ref/ngspice/src/spicelib/devices/cap/capsetup.c:102-117` (collapsed to single (n,n)- one terminal is ground)
- `CombinedRLElement`: NONE (digiTS-internal)

## Pin mapping

The transmission line composite does not get an `ngspiceNodeMap` on
`ComponentDefinition`- it decomposes into sub-elements. User-facing pin
layout (4 pins, 2 per port- preserved from current source):

| digiTS pin label | port | role |
|---|---|---|
| `P1b` | Port 1 | high side (signal) |
| `P1a` | Port 1 | return / ground side |
| `P2b` | Port 2 | high side (signal) |
| `P2a` | Port 2 | return / ground side |

Per the existing factory in `transmission-line.ts:874-877`, only `P1b`
and `P2b` are passed as MNA nodes to the segment chain (Port-1-high and
Port-2-high). The return pins `P1a` / `P2a` are not currently used inside
the analog element- they exist for visual/routing purposes and report
ground-return current via `getPinCurrents`. This wiring is preserved.

## Internal nodes

The composite allocates `2 × (N - 1)` internal voltage nodes per segment
chain:
- `rlMidNodes[k]` for k=0..N-2- between R and L within each non-final
  segment (N-1 nodes)
- `junctionNodes[k]` for k=0..N-2- between L and the next segment's R
  (N-1 nodes)

Each internal node is allocated by `ctx.makeVolt(label, suffix)` during
the composite's `setup()` BEFORE forwarding to sub-elements. This is the
A3 invariant: any element creating internal nodes does so in setup(),
not during construction.

The composite passes the resulting node ids into each sub-element's
constructor. **The existing construction-time node id assignments must
move to setup()** per A6.3. The implementer restructures the composite
to allocate sub-elements lazily inside `setup()`- that is, the segment-
construction loop currently in the constructor (transmission-line.ts
lines 736-766) is moved into `setup()`. The composite's external pin
ids stay populated at construction (`pinNodeIds`); internal node ids
populate in setup().

## Branch rows

Each `SegmentInductorElement` allocates one branch row in its `setup()`
via `ctx.makeCur(label, "branch")`- same pattern as PB-IND. Branch
labels are unique per segment index: `${composite.label}_seg${k}_L`
for the k-th segment's series inductor.

`CombinedRLElement` (the final segment only) also allocates one branch
row via `ctx.makeCur`- label `${composite.label}_seg${N-1}_RL`.

Total branch rows allocated per composite: **N** (one per segment;
N-1 from `SegmentInductorElement`s plus 1 from `CombinedRLElement`).

`SegmentResistorElement`, `SegmentShuntConductanceElement`, and
`SegmentCapacitorElement` allocate no branch rows.

## State slots

Per segment:
- `SegmentResistorElement`: 0 state slots (linear, no companion)
- `SegmentInductorElement`: 5 slots- uses `SEGMENT_INDUCTOR_SCHEMA`
  (`GEQ`, `IEQ`, `I_PREV`, `PHI`, `CCAP`). This differs from the 2-slot
  ngspice INDflux/INDvolt schema; the divergence is covered by the
  architectural-alignment.md entry from ssPre-condition.
- `SegmentShuntConductanceElement`: 0 state slots
- `SegmentCapacitorElement`: 5 slots- uses `SEGMENT_CAPACITOR_SCHEMA`
  (`GEQ`, `IEQ`, `V_PREV`, `Q`, `CCAP`)
- `CombinedRLElement`: 5 slots- uses `COMBINED_RL_SCHEMA`
  (`GEQ`, `IEQ`, `I_PREV`, `PHI`, `CCAP`)

Per-segment state-slot total: R(0) + L(5) + G(0) + C(5) = 10 slots per
non-final segment. Final segment uses CombinedRL(5) = 5 slots.

**Total state slots:** `(N - 1) × 10 + 5`. For N=10: 95 slots. Lossless
(gSeg=0) yields the same total because `SegmentShuntConductanceElement`
contributes 0 slots either way.

`stateSize` aggregates these across all reactive sub-elements via the
existing pattern at `transmission-line.ts:773-779`. `initState(pool)`
distributes offsets to reactive sub-elements (existing pattern at lines
788-799 preserved unchanged). `stateBaseOffset` is set by
`MNAEngine._setup()` per `00-engine.md` ssA5.1.

## Composite `setup()` body

```ts
setup(ctx: SetupContext): void {
  const N = this._segments;
  const nodeIds = this.pinNodeIds;  // [P1b, P2b] from constructor

  // Allocate (N-1) rlMid internal nodes and (N-1) junction internal nodes.
  const rlMidNodes: number[] = [];
  const junctionNodes: number[] = [];
  for (let k = 0; k < N - 1; k++) {
    rlMidNodes.push(ctx.makeVolt(this.label ?? "tline", `rlMid${k}`));
  }
  for (let k = 0; k < N - 1; k++) {
    junctionNodes.push(ctx.makeVolt(this.label ?? "tline", `junc${k}`));
  }

  // Construct the segment-chain sub-elements with allocated internal node
  // ids. This loop is moved here from the constructor (lines 736-766 of
  // pre-W3.5 source).
  this._subElements = [];
  for (let k = 0; k < N; k++) {
    const inputNode = k === 0 ? nodeIds[0] : junctionNodes[k - 1];

    if (k < N - 1) {
      const rlMid = rlMidNodes[k];
      const junctionNode = junctionNodes[k];

      // Series R: inputNode → rlMid
      this._subElements.push(new SegmentResistorElement(inputNode, rlMid, this._rSeg));

      // Series L: rlMid → junctionNode (label drives makeCur in L.setup)
      this._subElements.push(new SegmentInductorElement(
        rlMid, junctionNode,
        `${this.label ?? "tline"}_seg${k}_L`,
        this._lSeg,
      ));

      // Shunt G: junctionNode → GND (lossy only)
      if (this._gSeg > 0) {
        this._subElements.push(new SegmentShuntConductanceElement(junctionNode, this._gSeg));
      }

      // Shunt C: junctionNode → GND
      this._subElements.push(new SegmentCapacitorElement(junctionNode, this._cSeg));
    } else {
      // Last segment: combined RL to Port2, no shunt at Port2.
      this._subElements.push(new CombinedRLElement(
        inputNode, nodeIds[1],
        `${this.label ?? "tline"}_seg${k}_RL`,
        this._rSeg, this._lSeg,
      ));
    }
  }

  // Forward setup() to every sub-element. Order within a segment:
  // R → L → (G if lossy) → C, and the final segment is CombinedRL alone.
  // Across segments: 0, 1, 2, ..., N-1.
  for (const el of this._subElements) {
    el.setup(ctx);
  }

  // Cache branch indices for getPinCurrents.
  this._firstBranchIdx = this._extractFirstBranchIdx();
  this._lastBranchIdx  = this._extractLastBranchIdx();
}
```

The two helpers `_extractFirstBranchIdx` and `_extractLastBranchIdx`
read `branchIndex` from the appropriate sub-element. For N≥2 the first
branch-bearing sub-element is `_subElements[1]` (the
`SegmentInductorElement` of segment 0); for N=1 it's `_subElements[0]`
(the lone `CombinedRLElement`). The last is always the final element of
the array (`CombinedRLElement`). Implementer adds these as private
methods on the composite.

The constructor's existing segment-construction loop (lines 736-766) is
**deleted**. The constructor only stores per-segment scalar parameters
(`_rSeg`, `_lSeg`, `_gSeg`, `_cSeg`, `_segments`, `pinNodeIds`, `label`)-
sub-element construction moves entirely to `setup()`.

## Sub-element class specs

### `SegmentResistorElement.setup(ctx)`

ngspice anchor: `ressetup.c:46-49`. Constructor signature unchanged
(`new SegmentResistorElement(nA, nB, resistance)`). Pre-computed `G`
field cached at construction.

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const nA = this.pinNodeIds[0];
  const nB = this.pinNodeIds[1];

  // ressetup.c:46-49- TSTALLOC sequence, 4 entries.
  this._hAA = solver.allocElement(nA, nA);
  this._hAB = solver.allocElement(nA, nB);
  this._hBA = solver.allocElement(nB, nA);
  this._hBB = solver.allocElement(nB, nB);
}
```

Add fields to `SegmentResistorElement`:
```ts
private _hAA: number = -1;
private _hAB: number = -1;
private _hBA: number = -1;
private _hBB: number = -1;
```

`load()` body change: replace the 4 inline `stampG` calls (which
allocate handles via `allocElement` internally) with `solver.stampElement`
calls using the cached handles. Stamp values `+G`, `-G`, `-G`, `+G`
unchanged.

### `SegmentInductorElement.setup(ctx)`

ngspice anchor: `indsetup.c:78-100`. Constructor signature changes:
`new SegmentInductorElement(nA, nB, label, inductance)`- replaces the
existing 4-arg constructor that takes a pre-allocated branch index. The
branch index is now allocated by `setup()` itself via `ctx.makeCur`.

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this.pinNodeIds[0];
  const negNode = this.pinNodeIds[1];

  // Branch row allocation per indsetup.c:84-88- idempotent guard.
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this._label, "branch");
  }
  const b = this.branchIndex;

  // indsetup.c:96-100- TSTALLOC sequence, 5 entries (line-for-line).
  this._hPIbr   = solver.allocElement(posNode, b);
  this._hNIbr   = solver.allocElement(negNode, b);
  this._hIbrN   = solver.allocElement(b, negNode);
  this._hIbrP   = solver.allocElement(b, posNode);
  this._hIbrIbr = solver.allocElement(b, b);
}
```

Add fields:
```ts
private _hPIbr:   number = -1;
private _hNIbr:   number = -1;
private _hIbrN:   number = -1;
private _hIbrP:   number = -1;
private _hIbrIbr: number = -1;
private readonly _label: string;  // assigned in constructor
```

`branchIndex` becomes mutable (`branchIndex: number = -1`) per A3.

`load()` body change: replace the 5 inline `solver.allocElement` calls
(currently at lines 425-429) with `solver.stampElement` calls using the
cached handles. State-slot reads/writes (PHI, CCAP, GEQ, IEQ, I_PREV)
unchanged. The existing `SEGMENT_INDUCTOR_SCHEMA` stays- divergence
from ngspice 2-slot schema is covered by the architectural-alignment
entry.

### `SegmentShuntConductanceElement.setup(ctx)`

ngspice anchor: `ressetup.c:46-49` collapsed to single (n,n) entry-
one terminal is hard-wired to ground. Constructor signature unchanged
(`new SegmentShuntConductanceElement(node, G)`).

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const n = this.pinNodeIds[0];
  // Single TSTALLOC: (n, n). The (0, 0), (n, 0), (0, n) entries that
  // would exist if the cathode were a real node fall on row/col 0
  // (ground discard) and are not allocated.
  this._hNN = solver.allocElement(n, n);
}
```

Add field:
```ts
private _hNN: number = -1;
```

`load()` body change: replace `stampG(ctx.solver, n, n, this.G)` with
`solver.stampElement(this._hNN, this.G)`.

### `SegmentCapacitorElement.setup(ctx)`

ngspice anchor: `capsetup.c:102-117` collapsed to single (n,n) entry-
one terminal is hard-wired to ground. Constructor signature unchanged
(`new SegmentCapacitorElement(node, capacitance)`).

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const n = this.pinNodeIds[0];
  // Single TSTALLOC: (n, n). The capsetup pattern's (pos, pos), (neg,
  // neg), (pos, neg), (neg, pos) collapses to (n, n) only because
  // negNode = 0 (ground), and all (neg, *) / (*, neg) entries are
  // discarded.
  this._hNN = solver.allocElement(n, n);
}
```

Add field:
```ts
private _hNN: number = -1;
```

`load()` body change: replace inline `solver.allocElement(n0, n0)` calls
with `solver.stampElement(this._hNN, geq)`. State-slot reads/writes
(Q, V_PREV, GEQ, IEQ, CCAP) unchanged.

### `CombinedRLElement.setup(ctx)`- digiTS-internal, NO ngspice anchor

This class merges series R and series L into a single branch-row equation
to avoid creating an internal mid-node. It has no ngspice equivalent. Per
`02-behavioral.md` rationale ("behavioral elements are digiTS primitives
... NOT bound by ngspice line-for-line equivalence"), the setup body
matches the existing alloc pattern from current `load()`:

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const nA = this.pinNodeIds[0];
  const nB = this.pinNodeIds[1];

  // Branch row allocation- same idempotent pattern as SegmentInductorElement.
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this._label, "branch");
  }
  const b = this.branchIndex;

  // 5 TSTALLOC entries- same shape as SegmentInductorElement, but the
  // (b, b) handle's stamped value during load() includes the -R
  // contribution in addition to -geq, per the combined-RL branch
  // equation:  V(A) - V(B) - (R + geq)·I = ceq.
  this._hPIbr   = solver.allocElement(nA, b);
  this._hNIbr   = solver.allocElement(nB, b);
  this._hIbrN   = solver.allocElement(b, nB);
  this._hIbrP   = solver.allocElement(b, nA);
  this._hIbrIbr = solver.allocElement(b, b);
}
```

Constructor signature changes: `new CombinedRLElement(nA, nB, label,
resistance, inductance)`- adds the `label` parameter for branch
allocation. Existing `R`, `L` fields preserved.

Add fields:
```ts
private _hPIbr:   number = -1;
private _hNIbr:   number = -1;
private _hIbrN:   number = -1;
private _hIbrP:   number = -1;
private _hIbrIbr: number = -1;
private readonly _label: string;  // assigned in constructor
```

`branchIndex` becomes mutable.

`load()` body change: replace inline allocElement calls (lines 656-660)
with `solver.stampElement` using cached handles. The `(b, b)` stamp
value is `-(this.R + geq)` (semantic unchanged from line 660; only
allocation moves to setup()).

## Composite `load()` body- value writes only

Unchanged from current source (line 801-805): forwards to all
sub-elements via `for (const el of this._subElements) el.load(ctx);`.
After this migration, no `solver.allocElement` calls remain in any
sub-element's load().

## Composite `getLteTimestep`- unchanged

The existing implementation (lines 807-829) walks `_subElements`,
filters by `el.isReactive`, reads from each sub-element's state pool,
and returns the minimum proposed dt via `cktTerr`. This pattern is
preserved verbatim- no spec change.

## Factory cleanup

For `createTransmissionLineElement` and the `MnaModel` registration:

- Drop `internalNodeIds` parameter from factory signature per A6.3-
  internal nodes now allocated in composite's setup() via `ctx.makeVolt`.
- Drop `branchIdx` parameter likewise- branches allocated in
  sub-element setup() via `ctx.makeCur`.
- Remove `branchCount` from `MnaModel.modelRegistry["behavioral"]`
  registration (per A6.2). Branch count is now sub-element-driven.
- Remove `getInternalNodeCount` from MnaModel- replaced by
  `mayCreateInternalNodes: true`.
- Remove `getInternalNodeLabels` from MnaModel- labels are now built
  setup-time inside `_makeNode` calls (per `00-engine.md` ssA2.2 / plan.md
  resolved decisions).
- Add `mayCreateInternalNodes: true` to MnaModel registration.
- Add `findBranchFor` callback that walks `_subElements` and returns the
  first non-zero `branchIndex` matching the requested label. The
  composite owns all sub-element branch labels, so it dispatches to the
  matching sub-element's `findBranchFor` (each `SegmentInductorElement`
  and `CombinedRLElement` exposes one) using the standard idempotent
  guard pattern.
- `ComponentDefinition.ngspiceNodeMap` left undefined (composite).

## State pool

The composite is pool-backed (`poolBacked = true as const` already in
the source; preserved). `stateSchema` is empty (`defineStateSchema(
"TransmissionLineElement", [])`). `stateSize` aggregates from reactive
sub-elements (existing pattern at lines 773-779). `initState`
distributes offsets to reactive sub-elements (existing pattern at lines
788-799). All pool participation goes through the unified
`_poolBackedElements` filter at construction in `ckt-context.ts:616`.

## Inter-spec dependency

PB-TLINE has **no inter-spec class-API dependencies**- every sub-element
class is inline in `transmission-line.ts`. The setup-load-split lesson
from PB-XFMR/PB-TAPXFMR (cross-PB shared classes need full external API
in the introducing PB) does not apply. PB-TLINE is fully self-contained
within its source file.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is
spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in `TransmissionLineElement` matches the composite spec
   block line-for-line.
2. Internal node allocation moved from constructor to `setup()` via
   `ctx.makeVolt`. Constructor's segment-construction loop (lines 736-766
   of pre-W3.5 source) is deleted.
3. `_subElements` array is constructed inside `setup()`, after internal
   nodes are allocated.
4. Each of the 5 sub-element classes has a `setup()` method matching its
   spec block line-for-line:
   - `SegmentResistorElement.setup`- 4 allocElement calls.
   - `SegmentInductorElement.setup`- 1 makeCur + 5 allocElement calls.
   - `SegmentShuntConductanceElement.setup`- 1 allocElement call.
   - `SegmentCapacitorElement.setup`- 1 allocElement call.
   - `CombinedRLElement.setup`- 1 makeCur + 5 allocElement calls.
5. Constructor signatures updated:
   - `SegmentInductorElement` takes `(nA, nB, label, L)`- drops the
     pre-allocated branchIdx parameter.
   - `CombinedRLElement` takes `(nA, nB, label, R, L)`- drops the
     pre-allocated branchIdx parameter, adds label.
6. `branchIndex` mutable on `SegmentInductorElement` and `CombinedRLElement`.
7. Each sub-element class has the spec-listed handle fields
   (`_hAA`/`_hAB`/...`_hPIbr`/...`_hNN` etc.).
8. No `solver.allocElement(...)` calls in any `load()` body across all
   6 classes (composite + 5 sub-elements).
9. `MnaModel` for behavioral model has `mayCreateInternalNodes: true`,
   `branchCount`/`getInternalNodeCount`/`getInternalNodeLabels` removed,
   `findBranchFor` callback added.
10. `spec/architectural-alignment.md` contains the transmission-line
    divergence entry (ssPre-condition check).
11. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/
    intentional-divergence/citation-divergence/partial) used in any commit
    message or report.
