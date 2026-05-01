# Task PB-BEHAV-SPLITTER

**digiTS file:** `src/solver/analog/behavioral-remaining.ts` (factory: `createSplitterAnalogElement`)
**ngspice anchor:** NONE- behavioral. setup() body replicates the existing `allocElement` calls embedded in `stampG()` within the current load() body (per 02-behavioral.md Shape rule 6).

## Composition (per 02-behavioral.md Shape rule 6)

| Sub-element | Type | Count |
|---|---|---|
| `inputPins` | `DigitalInputPinModel[]` | `numIn`- from prop `_inputCount` (default 1) |
| `outputPins` | `DigitalOutputPinModel[]` | `numOut`- from prop `_outputCount` (default 1) |
| `childElements` | `AnalogCapacitorElement[]` | 0..N (collected from all pin models via `collectPinModelChildren`) |

Both `numIn` and `numOut` are variable at factory-call time. Pin labels are dynamic bit-range strings (e.g. `"0"`, `"4-7"`, `"0,1"`). The factory reads them from `pinNodes` in pinLayout order: inputs occupy slots `0 .. numIn-1`, outputs occupy slots `numIn .. numIn+numOut-1`.

## Pin layout

| Slot | Label | Role |
|---|---|---|
| 0 .. numIn-1 | dynamic (e.g. `"0"`, `"4-7"`) | input- `DigitalInputPinModel` |
| numIn .. numIn+numOut-1 | dynamic | output- `DigitalOutputPinModel` (role="direct") |

## setup() body

```ts
setup(ctx: SetupContext): void {
  for (const pin of inputPins)  pin.setup(ctx);
  for (const pin of outputPins) pin.setup(ctx);
  for (const child of childElements) child.setup(ctx);
},
```

Forward order: **inputs → outputs → children** per 02-behavioral.md Shape rule 3.

Each `DigitalInputPinModel.setup(ctx)` allocates `(nodeId, nodeId)` per Shape rule 1.
Each `DigitalOutputPinModel.setup(ctx)` allocates `(nodeId, nodeId)` for role="direct" per Shape rule 2.
Each `AnalogCapacitorElement.setup(ctx)` allocates 4 entries per PB-CAP.md.

## load() body- behavioral description

The Splitter element's load() does the following per cycle:
1. For each input pin, read the current node voltage from `ctx.rhsOld[inputPin.nodeId]` (or whatever the post-W2.5 field name is for the resolved nodeId- see 02-behavioral.md Shape rule 1).
2. Convert each voltage to a logic level using the input pin's `readLogicLevel(voltage)` method (existing API on DigitalInputPinModel).
3. Latch the logic levels into the splitter's internal latch state.
4. For each output pin, drive the output via `outputPin.setLogicLevel(latchedLevel)` (existing API on DigitalOutputPinModel).

The exact field names (`inputPins`, `outputPins`, `latchedLevels`) are the post-W2.5 class-based field names per 02-behavioral.md ssShape rule 3. If the existing source uses different names pre-W2.5, the W2.5 wave renames them; W3 implementer agents see the post-W2.5 names.

No new methods on DigitalInputPinModel or DigitalOutputPinModel are needed- readLogicLevel and setLogicLevel already exist.

## Pin model TSTALLOCs

Allocated by sub-element setup() calls- composite allocates nothing directly:

| Sub-element | allocElement calls | Condition |
|---|---|---|
| each `inputPins[i]` (DigitalInputPinModel) | `(nodeId, nodeId)` | if loaded and nodeId > 0 |
| each `outputPins[i]` (DigitalOutputPinModel, role="direct") | `(nodeId, nodeId)` | if nodeId > 0 |
| each `child` (AnalogCapacitorElement) | 4× per cap per PB-CAP.md | if cap nodes > 0 |

Total entry count is variable and determined entirely by numIn, numOut, and which pins are loaded/wired.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral- per 02-behavioral.md ssPin-map field).
- `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

`stateSize = childElements.reduce((s, c) => s + c.stateSize, 0)`- unchanged; driven entirely by capacitor children. Zero if no capacitor children are present.

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
