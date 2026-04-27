# Task PB-BEHAV-SEVENSEGHEX

**digiTS file:** `src/solver/analog/behavioral-remaining.ts` (factory: `createSevenSegAnalogElement`, reused by SevenSegHex)
**ngspice anchor:** NONE — behavioral. setup() body is identical to PB-BEHAV-SEVENSEG (per 02-behavioral.md Shape rule 7). The SevenSegHex component registers `createSevenSegAnalogElement` as its analog factory — the same factory as SevenSeg.

## Composition (per 02-behavioral.md Shape rule 7)

| Sub-element | Type | Count |
|---|---|---|
| `segDiodes` | `SegmentDiodeElement` (inline closure) | 8 — one per segment channel |

SevenSegHex is a 4-bit BCD/hex decoder feeding 7 segments + dp. The **digital** model (executeSevenSegHex) performs the decoding; the **analog** model is identical to SevenSeg: 8 parallel `SegmentDiodeElement` instances, one per output segment channel. The component registered at `src/components/io/seven-seg-hex.ts` line 210 uses `createSevenSegAnalogElement` directly — no separate analog factory is required or exists.

The difference between SevenSeg and SevenSegHex is entirely in the digital execution function (`executeSevenSegHex` vs `executeSevenSeg`) and pin layout (`d`+`dp` inputs vs 8 individual segment inputs). The analog stamp is the same 8-diode structure.

## Pin layout

SevenSegHex has 2 input pins at the component level:

| Position | Label | Kind |
|---|---|---|
| 0 | `d` | 4-bit BCD/hex data input |
| 1 | `dp` | 1-bit decimal point |

However, `createSevenSegAnalogElement` addresses the segment pins by the labels `a`,`b`,`c`,`d`,`e`,`f`,`g`,`dp` when called with `pinNodes`. For SevenSegHex the compiler must map the 4-bit `d` input and the `dp` input to these segment-labelled nodes. The analog factory always treats `pinNodes` as segment-to-node mappings; the component-level pin structure differs between SevenSeg and SevenSegHex, but the factory interface is the same.

**Implementer note:** if the compiler does not supply segment-labelled node entries for SevenSegHex (because its pins are `d` and `dp` only), the `pinNodes.get("a")!` calls in the factory will return `undefined` and produce `NaN` node IDs. Verify that the compiler's analog compilation path resolves SevenSegHex pin nodes to the segment channel nodes correctly before marking GREEN. This may require a component-definition change or a separate analog factory for SevenSegHex; if so, escalate — do not silently patch.

## SegmentDiodeElement setup() body

Identical to PB-BEHAV-SEVENSEG — see that spec for the full `createSegmentDiodeElement` implementation including the 4-handle allocation pattern with `if (nodeAnode > 0)` and `if (nodeCathode > 0)` guards. Since `createSevenSegAnalogElement` is shared, the `SegmentDiodeElement` migration done for SEVENSEG covers SEVENSEGHEX automatically.

```ts
setup(ctx: SetupContext): void {
  const s = ctx.solver;
  if (nodeAnode > 0)   _hAA = s.allocElement(nodeAnode, nodeAnode);
  if (nodeCathode > 0) _hCC = s.allocElement(nodeCathode, nodeCathode);
  if (nodeAnode > 0 && nodeCathode > 0) {
    _hAC = s.allocElement(nodeAnode, nodeCathode);
    _hCA = s.allocElement(nodeCathode, nodeAnode);
  }
},
```

## Composite setup() body

Identical to SevenSeg — 8 diodes in array order:

```ts
setup(ctx: SetupContext): void {
  for (const d of segDiodes) d.setup(ctx);
},
```

## load() body — value writes only

Identical to SevenSeg. The decoder logic lives in the digital execution function, not in the analog load():

```ts
load(ctx: LoadContext): void {
  for (const d of segDiodes) d.load(ctx);
},
```

No `allocElement` calls remain in load() after migration (shared with SEVENSEG — single implementation).

## Pin model TSTALLOCs

Same as PB-BEHAV-SEVENSEG: up to 8 `_hAA` entries (one per segment pin that resolves to a non-ground node). `_hCC`, `_hAC`, `_hCA` are not allocated when cathode = 0.

## Factory cleanup

- SevenSegHex registers `createSevenSegAnalogElement` — no separate factory to modify.
- The `SevenSegHexDefinition.modelRegistry.behavioral.factory` field in `src/components/io/seven-seg-hex.ts` already points to `createSevenSegAnalogElement`; no change needed there.
- `ngspiceNodeMap` left undefined on `SevenSegHexDefinition` (behavioral — per 02-behavioral.md §Pin-map field).
- `hasBranchRow: false`, `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

`stateSize: 0` — same as SevenSeg. No pool-backed state.

## Verification gate

1. Existing test file `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN.
2. Existing test file `src/components/io/__tests__/segment-displays.test.ts` is GREEN.
3. No `allocElement` call in any load() body. Verified by: `Grep "allocElement" src/solver/analog/behavioral-remaining.ts` returns only matches inside `setup()` method bodies (same grep as SEVENSEG — single file, single verification pass covers both).
4. No banned closing verdicts.
