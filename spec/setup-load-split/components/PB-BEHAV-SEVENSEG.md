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

## SegmentDiodeElement setup() body (Shape rule 7)

This is the critical action item for this task: add a `setup(ctx)` method to the inline `SegmentDiodeElement` closure returned by `createSegmentDiodeElement`. The method allocates 4 handle fields that load() then stamps through.

The cathode is always node 0 (ground) for SevenSeg, so `nodeCathode = 0` throughout. The `if (nodeCathode > 0)` guard for `_hCC` and the cross-terms will always be false for this usage, but the guards must remain in the helper for correctness in other contexts (e.g. ButtonLED where cathode could be non-zero in future).

```ts
function createSegmentDiodeElement(
  nodeAnode: number,
  nodeCathode: number,
): SegmentDiodeElement {
  let geq = LED_GMIN;
  let ieq = 0;
  let _vdStored = 0;
  let _idStored = 0;

  // Handle fields — allocated in setup(), stamped in load()
  let _hAA: number = -1;  // (anode, anode)
  let _hCC: number = -1;  // (cathode, cathode)
  let _hAC: number = -1;  // (anode, cathode)
  let _hCA: number = -1;  // (cathode, anode)

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    isReactive: false,

    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeAnode > 0)   _hAA = s.allocElement(nodeAnode, nodeAnode);
      if (nodeCathode > 0) _hCC = s.allocElement(nodeCathode, nodeCathode);
      if (nodeAnode > 0 && nodeCathode > 0) {
        _hAC = s.allocElement(nodeAnode, nodeCathode);
        _hCA = s.allocElement(nodeCathode, nodeAnode);
      }
    },

    load(ctx: LoadContext): void {
      // Existing diode model logic unchanged, but stamp through cached handles
      // instead of calling stampG() (which calls allocElement internally).
      const rhsOld = ctx.rhsOld;
      const va = nodeAnode   > 0 ? rhsOld[nodeAnode]   : 0;
      const vc = nodeCathode > 0 ? rhsOld[nodeCathode] : 0;
      const vd = va - vc;
      if (vd > LED_VF) {
        geq = 1 / LED_RON + LED_GMIN;
        ieq = geq * LED_VF - LED_GMIN * vd;
      } else {
        geq = 1 / LED_ROFF + LED_GMIN;
        ieq = 0;
      }
      _vdStored = vd;
      _idStored = geq * vd + ieq;

      // Stamp conductance through cached handles (no allocElement)
      if (_hAA >= 0) ctx.solver.stampElement(_hAA,  geq);
      if (_hCC >= 0) ctx.solver.stampElement(_hCC,  geq);
      if (_hAC >= 0) ctx.solver.stampElement(_hAC, -geq);
      if (_hCA >= 0) ctx.solver.stampElement(_hCA, -geq);
      // RHS stamps are node-index writes, not matrix entries — unchanged:
      if (nodeAnode   > 0) ctx.rhs[nodeAnode]   -= ieq;
      if (nodeCathode > 0) ctx.rhs[nodeCathode] += ieq;
    },

    // checkConvergence, anodeCurrent, getPinCurrents, setParam — unchanged
  };
}
```

Note: the existing `stampG()` call in the current load() body calls `solver.allocElement` on every NR iteration. After migration, `stampG()` is replaced by the direct `stampElement(_hXX, ...)` calls above. The `stampG()` helper itself is left in the file (it may be used by other code), but must no longer be called from any `load()` body.

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

The guards `if (nodeCathode > 0)` are NOT removed from `createSegmentDiodeElement` — ButtonLED reuses this helper and may supply a non-zero cathode in future variants.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral — per 02-behavioral.md §Pin-map field).
- `hasBranchRow: false`, `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

`stateSize: 0` — SevenSeg has no state pool slots. `poolBacked` is not set on the current composite (it returns a plain `AnalogElementCore`). No `initState` / `stateBaseOffset` fields required.

## Verification gate

1. Existing test file `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN.
2. Existing test file `src/components/io/__tests__/segment-displays.test.ts` is GREEN.
3. No `allocElement` call in any load() body (composite or `SegmentDiodeElement`). Verified by: `Grep "allocElement" src/solver/analog/behavioral-remaining.ts` returns only matches inside `setup()` method bodies.
4. `stampG()` is not called from any load() body in the file after migration.
5. No banned closing verdicts.
