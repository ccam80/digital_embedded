# composite-transmission-line

## Site

- File: `src/components/passives/transmission-line.ts`
- Class: `TransmissionLineElement` (currently lines 731-973)
- Inline sub-element classes (stay as leaves):
  - `SegmentResistorElement` (lines 234-284)
  - `SegmentShuntConductanceElement` (lines 290-327)
  - `SegmentInductorElement` (lines 346-471)
  - `SegmentCapacitorElement` (lines 481-582)
  - `CombinedRLElement` (lines 594-725)
- Factories: `buildTransmissionLineElement`, `createTransmissionLineElement`
  (lines 979-1018)

## Sub-elements

For N segments (param `segments`, default 10), the composite generates a
chain of sub-elements:

| Per-segment shape | Sub-elements (in declaration order) |
|---|---|
| Segments 0..N-2 (mid-segments) | `seg{k}_R` (`SegmentResistorElement`), `seg{k}_L` (`SegmentInductorElement`), optional `seg{k}_G` (`SegmentShuntConductanceElement`, only when lossPerMeter > 0), `seg{k}_C` (`SegmentCapacitorElement`) |
| Segment N-1 (last) | `seg{N-1}_RL` (`CombinedRLElement` — series R+L in one element, no shunt) |

ngspice citations (per leaf class):

- `SegmentResistorElement`: `ressetup.c:46-49` (4 entries), `resload.c`
- `SegmentInductorElement`: `indsetup.c:84-100` (5 entries +
  branch), `indload.c:43-123`
- `SegmentShuntConductanceElement`: `ressetup.c` collapsed to single
  (n,n) entry (other terminal is GND)
- `SegmentCapacitorElement`: `capsetup.c:102-117` collapsed to single
  (n,n) entry (other terminal is GND)
- `CombinedRLElement`: derived from `indsetup.c:96-100` plus an extra `-R`
  contribution on the (b,b) diagonal

No prop-bag adapter helpers exist on this site — all per-segment param
values are pre-computed scalars (`_rSeg`, `_lSeg`, `_gSeg`, `_cSeg`)
passed directly to leaf constructors. **`PropertyBag.forModel` is
not used here** — the leaves are not registered through the unified
component registry; they are inline composite-only types with no .MODEL
parser entry. This is the canonical ngspice URC (Uniform RC) shape: the
URC composite at `ref/ngspice/src/spicelib/devices/urc/` expands at
parse time into discrete R, C device instances with hand-set parameters,
not via a per-segment .MODEL line.

## Internal nodes

For N segments, allocate `2*(N-1)` internal nodes in `setup()`:

| Labels | Purpose |
|---|---|
| `rlMid0` … `rlMid{N-2}` | Mid-node between R and L within each non-last segment |
| `junc0` … `junc{N-2}` | Segment-boundary node (carries shunt G+C to GND) |

`getInternalNodeLabels()` returns the concatenation in that order.

## Setup-order

The composite's outer `ngspiceLoadOrder` is `TRA = 43`
(`transmission-line.ts:736`). Within the composite, sub-elements are
declared segment-by-segment, R → L → (G if lossy) → C, ending with
CombinedRL for the last segment. This order is dictated by the
allocation dependency: `rlMid` and `junc` must exist before any leaf
references them in `_pinNodes`.

The setup ordering is currently iterative and correct
(`transmission-line.ts:813-867`). The base's `super.setup()` walks
sub-elements in declaration order, which preserves segment numbering.

## Load delegation

Default `super.load(ctx)` collapses the loop at
`transmission-line.ts:903-907`. No composite-level glue stamps. The
override goes away.

## Specific quirks

- **Sub-elements built lazily in `setup()`, not in the constructor.**
  Currently `_subElements` is filled inside `setup()` because internal
  node IDs aren't known until then. This is the ONE composite where the
  declarative `addSubElement(...)` constructor pattern doesn't work
  cleanly. Two options:

  1. **Keep `setup()`-time registration**: expose
     `addSubElement(name, element)` as `protected`; the
     transmission-line subclass calls it inside `setup()` after
     allocating internal nodes. The base's `super.setup()` then walks
     the just-registered children. Same end state as other composites,
     just with registration time shifted.
  2. **Construct children with sentinel `-1` pin nodes; bind in setup**:
     each `SegmentResistorElement(nA: -1, nB: -1, R)` is instantiated
     in the constructor; `setup()` calls `bindSubPin(...)` for every
     pin on every child. Symmetric with SCR/TRIAC/optocoupler, but
     N-dependent: the constructor must already know N (which it does —
     `segments` is a structural prop). The leaf classes' constructors
     currently accept node IDs as numbers, not Maps, so they'd need to
     accept `_pinNodes.set` calls after construction (which they
     already support via the `_pinNodes` field).

  **Recommendation: option 1.** Lazy registration matches the natural
  shape of N-dependent fan-out and keeps the leaves' constructor signature
  stable.

- **`stateSize` is dynamic**: total state grows with N. Currently computed
  in `setup()` at line 856-863. Once children are registered through
  `addSubElement` and the base's `stateSize` getter sums them, this
  manual computation goes away.

- **`getLteTimestep` overrides** (`transmission-line.ts:909-932`): the
  override walks pool-backed sub-elements directly to extract per-segment
  flux/charge state for a per-element LTE check. The base's
  `getLteTimestep` (`composite-element.ts:82-97`) takes the min over
  children's `getLteTimestep` — which the leaves already implement. Once
  the leaves expose `getLteTimestep` (most do not currently — they
  inline the `cktTerr` call into the composite's loop), the override can
  collapse. Otherwise the override stays.

- **`findBranchFor`** (`transmission-line.ts:934-943`) walks children
  asking each for the named branch. This duplicates the engine's normal
  branch-resolution path. Stays as a composite-level override (the base
  does not provide a default `findBranchFor`).

- **`_extractFirstBranchIdx` / `_extractLastBranchIdx`** (lines 870-884):
  bespoke logic that pokes into `_subElements[0]` and `_subElements[
  last]` to extract branch indices for `getPinCurrents`. After
  registration through `addSubElement`, these become
  `this.subElement<SegmentInductorElement>("seg0_L").branchIndex` and
  `this.subElement<CombinedRLElement>("seg${N-1}_RL").branchIndex`.

## Migration shape (sketch)

```ts
class TransmissionLineElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly stateSchema: StateSchema = TLINE_COMPOSITE_SCHEMA;  // empty

  // … constructor stores Z0, delay, lossDb, length, segments

  setup(ctx: SetupContext): void {
    const N = this._segments;
    const p1bNode = this._pinNodes.get("P1b")!;
    const p2bNode = this._pinNodes.get("P2b")!;

    const rlMid: number[] = [];
    const junc: number[]  = [];
    for (let k = 0; k < N - 1; k++) rlMid.push(ctx.makeVolt(this.label, `rlMid${k}`));
    for (let k = 0; k < N - 1; k++) junc.push(ctx.makeVolt(this.label, `junc${k}`));

    for (let k = 0; k < N; k++) {
      const inputNode = k === 0 ? p1bNode : junc[k - 1];
      if (k < N - 1) {
        this.addSubElement(`seg${k}_R`,
          new SegmentResistorElement(inputNode, rlMid[k], this._rSeg));
        this.addSubElement(`seg${k}_L`,
          new SegmentInductorElement(rlMid[k], junc[k], `${this.label}_seg${k}_L`, this._lSeg));
        if (this._gSeg > 0) {
          this.addSubElement(`seg${k}_G`,
            new SegmentShuntConductanceElement(junc[k], this._gSeg));
        }
        this.addSubElement(`seg${k}_C`,
          new SegmentCapacitorElement(junc[k], this._cSeg));
      } else {
        this.addSubElement(`seg${k}_RL`,
          new CombinedRLElement(inputNode, p2bNode, `${this.label}_seg${k}_RL`, this._rSeg, this._lSeg));
      }
    }

    super.setup(ctx);  // forwards to all just-registered sub-elements
  }

  // initState, load — collapse to base
  // getLteTimestep, findBranchFor — keep overrides until leaves expose them
  // getPinCurrents — replace _subElements[0/last] with this.subElement<…>(…)
}
```

## Resolves

This site does not currently have failing tests in
`test-results/test-failures.json`. Per `spec/test-fix-jobs.md`, the
transmission-line tests were earlier failing on `coordinator.speed` use,
which has been reverted (§B3 redo). The composite refactor here is
structural — eliminates the legacy `_subElements` field which is the last
user of `_walkSubElements`'s legacy fallback at
`analog-engine.ts:1386-1388`. Once this site uses `getSubElements()` (via
the base), the legacy fallback can be deleted.

Indirectly enables removal of the `_subElements` legacy path in
`analog-engine.ts:1383-1390`.

## Category

`architecture-fix`

## Out of scope (escalations)

- **Whether the leaves should expose `getLteTimestep()`** so the
  composite's override can collapse to `super.getLteTimestep`. The
  current leaves (SegmentInductorElement, SegmentCapacitorElement,
  CombinedRLElement) hand-roll the LTE per-segment math at the
  composite level (lines 909-932). Migrating each leaf to its own
  `getLteTimestep()` is a separate cleanup; flag for follow-up.
