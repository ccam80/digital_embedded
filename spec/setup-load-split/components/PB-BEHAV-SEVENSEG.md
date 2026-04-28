# Task PB-BEHAV-SEVENSEG

**digiTS file:** `src/solver/analog/behavioral-remaining.ts` (factory: `createSevenSegAnalogElement`)
**ngspice anchor:** NONE — behavioral. setup() body replicates the existing `allocElement` calls embedded in `stampG()` within `SegmentDiodeElement.load()` (per 02-behavioral.md Shape rule 7).

## Composition (per 02-behavioral.md Shape rule 7)

| Sub-element | Type | Count |
|---|---|---|
| `segDiodes` | `SegmentDiodeElement` (inline closure) | 8 — one per segment pin (`a`,`b`,`c`,`d`,`e`,`f`,`g`,`dp`) |

There are no `DigitalInputPinModel` / `DigitalOutputPinModel` sub-elements. Each segment pin connects directly to a `SegmentDiodeElement` whose anode = pin node, cathode = node 0 (ground, common-cathode configuration).

The SevenSeg composite has no `childElements` array (no capacitor children). All matrix entries are owned by the 8 segment diodes.

## Pin layout

| Position | Label | Role |
|---|---|---|
| 0 | `a` | segment anode input — `SegmentDiodeElement(segNodes[0], 0)` |
| 1 | `b` | segment anode input — `SegmentDiodeElement(segNodes[1], 0)` |
| 2 | `c` | segment anode input — `SegmentDiodeElement(segNodes[2], 0)` |
| 3 | `d` | segment anode input — `SegmentDiodeElement(segNodes[3], 0)` |
| 4 | `e` | segment anode input — `SegmentDiodeElement(segNodes[4], 0)` |
| 5 | `f` | segment anode input — `SegmentDiodeElement(segNodes[5], 0)` |
| 6 | `g` | segment anode input — `SegmentDiodeElement(segNodes[6], 0)` |
| 7 | `dp` | decimal point anode input — `SegmentDiodeElement(segNodes[7], 0)` |

`segNodes[i] = pinNodes.get(SEGMENT_LABELS[i])!` where `SEGMENT_LABELS = ["a","b","c","d","e","f","g","dp"]`.

## SegmentDiodeElement setup() body — owned by W2.6, NOT this task

**`createSegmentDiodeElement.setup()` ownership**: the helper's `setup()` body lands in W2 per W2.6 (see plan.md §"Wave plan" and 00-engine.md §A3.2). PB-BEHAV-SEVENSEG's W3 task does NOT write the helper — it only confirms the helper has a `setup` property. This eliminates the previously-documented race with PB-BEHAV-BUTTONLED.

The W3 SEVENSEG task is responsible only for the composite forward (next section) and for replacing `stampG()` calls inside `SegmentDiodeElement.load()` with direct `stampElement(_hXX, ...)` calls against the handles that W2.6's setup() body has already allocated. The handle fields `_hAA`, `_hCC`, `_hAC`, `_hCA` are populated by W2.6's setup() — load() reads them and stamps through.

Note: the existing `stampG()` call in the current load() body calls `solver.allocElement` on every NR iteration. After migration, `stampG()` is replaced by the direct `stampElement(_hXX, ...)` calls (`if (_hAA >= 0) ctx.solver.stampElement(_hAA, geq);` etc.).

The shared `stampG()` helper (in `src/solver/analog/stamp-helpers.ts`) is still consumed by other components (resistor, polarized-cap, transmission-line, etc.) and is NOT deleted by this task. PB-BEHAV-SEVENSEG only removes the `stampG()` calls inside the segment-diode load() body.

## Composite SevenSeg setup() body

```ts
// inside the existing return { ... } block in createSevenSegAnalogElement:
setup(ctx: SetupContext): void {
  for (const d of segDiodes) d.setup(ctx);
},
```

Forward order: all 8 segment diodes in array order (a → b → c → d → e → f → g → dp).

## load() body — value writes only

Existing load() body kept verbatim — only `d.load(ctx)` calls inside the for-loop. After `SegmentDiodeElement.load()` is migrated to stamp through handles, the composite load() requires no further changes:

```ts
load(ctx: LoadContext): void {
  for (const d of segDiodes) d.load(ctx);
},
```

No `allocElement` calls remain in either the composite or the diode helper load() bodies after migration.

## Pin model TSTALLOCs

Per diode (8 total, one per segment). For SevenSeg all cathodes = 0 so only `_hAA` is allocated per diode:

| Segment | allocElement calls | Active for SevenSeg (cathode=0) |
|---|---|---|
| `_hAA` | `(nodeAnode, nodeAnode)` | YES — if nodeAnode > 0 |
| `_hCC` | `(nodeCathode, nodeCathode)` | NO — cathode = 0 |
| `_hAC` | `(nodeAnode, nodeCathode)` | NO — cathode = 0 |
| `_hCA` | `(nodeCathode, nodeAnode)` | NO — cathode = 0 |

Total matrix entries added by setup(): up to 8 (one `_hAA` per segment pin that is wired to a non-ground node).

The `if (nodeCathode > 0)` guards inside `createSegmentDiodeElement` are owned by W2.6 (00-engine.md §A3.2). They are required because ButtonLED's cathode is structurally allowed to be ground (and is, in the current implementation). Per BATCH1-D2 Option C (engine spec §A6.6), shunt-to-ground-possible elements MUST guard their allocElement calls. This guard is not optional and is not removable in future variants.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral — per 02-behavioral.md §Pin-map field).
- `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

`stateSize: 0` — SevenSeg has no state pool slots. `poolBacked` is not set on the current composite (it returns a plain `AnalogElementCore`). No `initState` / `stateBaseOffset` fields required.

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
