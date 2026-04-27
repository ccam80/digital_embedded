# Task PB-BEHAV-DRIVER

**digiTS file:** `src/solver/analog/behavioral-remaining.ts` (factory: `createDriverAnalogElement`)
**ngspice anchor:** NONE — behavioral. setup() body replicates the existing `allocElement` calls embedded in `stampG()` within the current load() body (per 02-behavioral.md Shape rule 5).

## Composition (per 02-behavioral.md Shape rule 5)

| Sub-element | Type | Count |
|---|---|---|
| `inputPin` | `DigitalInputPinModel` | 1 (data input) |
| `selPin` | `DigitalInputPinModel` | 1 (enable input) |
| `outputPin` | `DigitalOutputPinModel` | 1 (tri-state output, role="direct") |
| `childElements` | `AnalogCapacitorElement[]` | 0..3 (collected from all three pin models via `collectPinModelChildren`) |

## Pin layout

| Position | Label | Role |
|---|---|---|
| 0 | `in` | data input — `DigitalInputPinModel` |
| 1 | `sel` | enable input — `DigitalInputPinModel` |
| 2 | `out` | tri-state output — `DigitalOutputPinModel` (role="direct") |

## setup() body

The current factory returns an object literal. Per the task instructions, add a `setup(ctx)` property to the existing returned object literal — no class refactor required.

```ts
// inside the existing return { ... } block in createDriverAnalogElement:
setup(ctx: SetupContext): void {
  inputPin.setup(ctx);
  selPin.setup(ctx);
  outputPin.setup(ctx);
  for (const child of childElements) child.setup(ctx);
},
```

Forward order: **inputs (data, enable) → output → children** (inputs first, output second, children last) per 02-behavioral.md Shape rule 3.

`DigitalInputPinModel.setup(ctx)` allocates `(nodeId, nodeId)` per Shape rule 1.
`DigitalOutputPinModel.setup(ctx)` allocates `(nodeId, nodeId)` for role="direct" per Shape rule 2.
Each `AnalogCapacitorElement.setup(ctx)` allocates 4 entries per PB-CAP.md.

## load() body — value writes only

Existing load() body kept verbatim minus any `solver.allocElement` calls. The `stampG()` helper currently calls `solver.allocElement` internally; after migration, `stampG` must be replaced by direct `solver.stampElement(handle, value)` calls using the handles allocated in setup(). The per-pin-model load() calls stamp through their own cached handles. No `allocElement` calls remain in load() after migration.

```ts
load(ctx: LoadContext): void {
  const v = ctx.rhsOld;

  inputPin.load(ctx);   // stamps rIn conductance via cached _hNodeDiag
  selPin.load(ctx);     // stamps rIn conductance via cached _hNodeDiag

  const vIn = readMnaVoltage(nodeIn, v);
  const vSel = readMnaVoltage(nodeSel, v);

  const inLevel = inputPin.readLogicLevel(vIn);
  if (inLevel !== undefined) latchedIn = inLevel;

  const selLevel = selPin.readLogicLevel(vSel);
  if (selLevel !== undefined) latchedSel = selLevel;

  outputPin.setHighZ(!latchedSel);
  outputPin.setLogicLevel(latchedIn);
  outputPin.load(ctx);  // stamps via cached handles

  for (const child of childElements) { child.load(ctx); }
},
```

## Pin model TSTALLOCs

Allocated by sub-element setup() calls — not by the composite directly:

| Sub-element | allocElement calls | Condition |
|---|---|---|
| `inputPin` (DigitalInputPinModel) | `(nodeIn, nodeIn)` | if loaded and nodeIn > 0 |
| `selPin` (DigitalInputPinModel) | `(nodeSel, nodeSel)` | if loaded and nodeSel > 0 |
| `outputPin` (DigitalOutputPinModel, role="direct") | `(nodeOut, nodeOut)` | if nodeOut > 0 |
| each `child` (AnalogCapacitorElement) | 4× per cap per PB-CAP.md | if cap nodes > 0 |

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral — no ngspice pin map per 02-behavioral.md §Pin-map field).
- `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.

## State pool

`stateSize = childElements.reduce((s, c) => s + c.stateSize, 0)` — unchanged; driven entirely by capacitor children. Zero if no capacitor children are present.

## Verification gate

1. Existing test file `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
2. No `allocElement` call in load() body. Verified by: `Grep "allocElement" src/solver/analog/behavioral-remaining.ts` returns only matches inside `setup()` method bodies.
3. `setup()` forward order is inputs → outputs → children (Shape rule 3).
4. No banned closing verdicts.
