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

## Migration note
Both `createSevenSegAnalogElement` (used by SevenSeg with 8 segment-pins) and `createSevenSegHexAnalogElement` (used by SevenSegHex with d+dp internal-decoder pins) coexist. They share `createSegmentDiodeElement` as a helper.

## Source-read exception
For this one task, the implementer may read `executeSevenSegHex` in `seven-seg-hex.ts` to copy the BCD-to-segment lookup table verbatim (the lookup must match exactly to preserve digital-side behavior). No other source reads permitted.

## ngspice anchor: NONE
SevenSegHex has no ngspice equivalent.
