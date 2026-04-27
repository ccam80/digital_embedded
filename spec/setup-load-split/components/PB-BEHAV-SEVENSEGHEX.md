# PB-BEHAV-SEVENSEGHEX

## Pin layout (unchanged)
- `d` — 4-bit BCD input
- `dp` — decimal-point input

(No segment-output pins on the public component.)

## Factory: createSevenSegHexAnalogElement (NEW, distinct from createSevenSegAnalogElement)

A new factory in `src/solver/analog/behavioral-remaining.ts` that maps SevenSegHex's `d` and `dp` pins to 8 internal SegmentDiodeElement instances using the same BCD-to-segment lookup as `executeSevenSegHex`.

```ts
export function createSevenSegHexAnalogElement(props: { /* standard factory props */ }): AnalogElementCore {
  const dNode = props.pinNodes.get("d")!;
  const dpNode = props.pinNodes.get("dp")!;
  const segmentLabels = ["a", "b", "c", "d_seg", "e", "f", "g", "dp_seg"] as const;
  const segments = segmentLabels.map(label => createSegmentDiodeElement({ /* ... */ }));

  return {
    setup(ctx) { for (const seg of segments) seg.setup(ctx); },
    load(ctx) {
      const bcdValue = decodeBCD(ctx.rhsOld[dNode]);  // existing helper from executeSevenSegHex
      const segmentStates = bcdToSegments(bcdValue);
      const dpHigh = ctx.rhsOld[dpNode] >= 0.5;
      for (let i = 0; i < 7; i++) segments[i].setLogicLevel(segmentStates[i]);
      segments[7].setLogicLevel(dpHigh);
      for (const seg of segments) seg.load(ctx);
    },
    accept(ctx) { for (const seg of segments) seg.accept?.(ctx); },
  };
}
```

## SevenSegHexDefinition update
`SevenSegHexDefinition.modelRegistry.behavioral.factory` is changed from `createSevenSegAnalogElement` to `createSevenSegHexAnalogElement`.

## Verification gate (W3)
1. `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN; new tests assert BCD decoding for values 0, 1, 9, 10, 15.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
2. setup-stamp-order test row: 8 × SegmentDiodeElement entries in segment order (a, b, c, d_seg, e, f, g, dp_seg).
3. Existing circuits using SevenSegHex remain functional (compiler-level pin handling unchanged).

## Migration note
Both `createSevenSegAnalogElement` (used by SevenSeg with 8 segment-pins) and `createSevenSegHexAnalogElement` (used by SevenSegHex with d+dp internal-decoder pins) coexist. They share `createSegmentDiodeElement` as a helper.

## Source-read exception
For this one task, the implementer may read `executeSevenSegHex` in `seven-seg-hex.ts` to copy the BCD-to-segment lookup table verbatim (the lookup must match exactly to preserve digital-side behavior). No other source reads permitted.

## ngspice anchor: NONE
SevenSegHex has no ngspice equivalent.
