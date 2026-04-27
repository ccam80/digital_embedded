# Task PB-BEHAV-SPLITTER

**digiTS file:** `src/solver/analog/behavioral-remaining.ts` (factory: `createSplitterAnalogElement`)
**ngspice anchor:** NONE — behavioral. setup() body replicates the existing `allocElement` calls embedded in `stampG()` within the current load() body (per 02-behavioral.md Shape rule 6).

## Composition (per 02-behavioral.md Shape rule 6)

| Sub-element | Type | Count |
|---|---|---|
| `inputPins` | `DigitalInputPinModel[]` | `numIn` — from prop `_inputCount` (default 1) |
| `outputPins` | `DigitalOutputPinModel[]` | `numOut` — from prop `_outputCount` (default 1) |
| `childElements` | `AnalogCapacitorElement[]` | 0..N (collected from all pin models via `collectPinModelChildren`) |

Both `numIn` and `numOut` are variable at factory-call time. Pin labels are dynamic bit-range strings (e.g. `"0"`, `"4-7"`, `"0,1"`). The factory reads them from `pinNodes` in pinLayout order: inputs occupy slots `0 .. numIn-1`, outputs occupy slots `numIn .. numIn+numOut-1`.

## Pin layout

| Slot | Label | Role |
|---|---|---|
| 0 .. numIn-1 | dynamic (e.g. `"0"`, `"4-7"`) | input — `DigitalInputPinModel` |
| numIn .. numIn+numOut-1 | dynamic | output — `DigitalOutputPinModel` (role="direct") |

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

## load() body — behavioral description

The Splitter element's load() does the following per cycle:
1. For each input pin, read the current node voltage from `ctx.rhsOld[inputPin.nodeId]` (or whatever the post-W2.5 field name is for the resolved nodeId — see 02-behavioral.md Shape rule 1).
2. Convert each voltage to a logic level using the input pin's `readLogicLevel(voltage)` method (existing API on DigitalInputPinModel).
3. Latch the logic levels into the splitter's internal latch state.
4. For each output pin, drive the output via `outputPin.setLogicLevel(latchedLevel)` (existing API on DigitalOutputPinModel).

The exact field names (`inputPins`, `outputPins`, `latchedLevels`) are the post-W2.5 class-based field names per 02-behavioral.md §Shape rule 3. If the existing source uses different names pre-W2.5, the W2.5 wave renames them; W3 implementer agents see the post-W2.5 names.

No new methods on DigitalInputPinModel or DigitalOutputPinModel are needed — readLogicLevel and setLogicLevel already exist.

## Pin model TSTALLOCs

Allocated by sub-element setup() calls — composite allocates nothing directly:

| Sub-element | allocElement calls | Condition |
|---|---|---|
| each `inputPins[i]` (DigitalInputPinModel) | `(nodeId, nodeId)` | if loaded and nodeId > 0 |
| each `outputPins[i]` (DigitalOutputPinModel, role="direct") | `(nodeId, nodeId)` | if nodeId > 0 |
| each `child` (AnalogCapacitorElement) | 4× per cap per PB-CAP.md | if cap nodes > 0 |

Total entry count is variable and determined entirely by numIn, numOut, and which pins are loaded/wired.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral — per 02-behavioral.md §Pin-map field).
- `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

`stateSize = childElements.reduce((s, c) => s + c.stateSize, 0)` — unchanged; driven entirely by capacitor children. Zero if no capacitor children are present.

## Verification gate

1. Existing test file `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
2. No `allocElement` call in load() body. Verified by: `Grep "allocElement" src/solver/analog/behavioral-remaining.ts` returns only matches inside `setup()` method bodies.
3. `setup()` forward order is inputs → outputs → children (Shape rule 3 / Shape rule 6).
4. No banned closing verdicts.
