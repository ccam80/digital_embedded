# Task PB-BEHAV-GROUND

**digiTS file:** `src/components/io/ground.ts` (factory: `createGroundAnalogElement`)
**ngspice anchor:** NONE — behavioral. Ground is a node-zero sentinel with no matrix entries and no state. setup() body is empty (per 02-behavioral.md §Behavioral element list, Ground row).

## Composition

| Sub-element | Type | Count |
|---|---|---|
| (none) | — | 0 |

Ground has no sub-elements, no pin models, no capacitor children, no segment diodes. It is the simplest possible behavioral analog element.

## Pin layout

| Position | Label | Role |
|---|---|---|
| 0 | `out` | ground sentinel — compiler maps this pin's node to MNA node 0 |

`pinNodes.get("out")` is called by the current factory (reads the value but uses it only to confirm the pin exists). The pin maps to MNA node 0 by compiler convention; no matrix row or column is allocated for it.

## setup() body

```ts
setup(_ctx: SetupContext): void {
  // Ground constraint is handled by the compiler's node mapping.
  // No matrix entries, no branch rows, no state slots to allocate.
},
```

The body is empty. There are no `allocElement`, `makeCur`, `makeVolt`, or `allocStates` calls.

## load() body — value writes only

Existing load() body kept verbatim — it is already empty:

```ts
load(_ctx: LoadContext): void {
  // Ground constraint is handled by the compiler's node mapping.
},
```

No change required. There were no `allocElement` calls to move.

## Pin model TSTALLOCs

None. Ground allocates zero matrix entries in setup().

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` parameters from factory signature (new 3-param form per A6.3).
- `ngspiceNodeMap` left undefined (behavioral — per 02-behavioral.md §Pin-map field).
- `mayCreateInternalNodes: false`.
- No `findBranchFor` callback.
- `ngspiceLoadOrder` is currently `NGSPICE_LOAD_ORDER.RES` (lowest bucket, since ordinal is irrelevant for a no-op stamper). This is correct and unchanged.

## State pool

`stateSize: 0` (implicit — no `poolBacked` field, no `initState`). No state pool slots. The current factory returns a plain `AnalogElementCore` object literal with no pool-backed fields; this is unchanged.

## Notes on no-op status

Ground is not just an empty behavioral element — it is architecturally a sentinel. The compiler maps the output pin's wired node to MNA node 0 at compile time. Ground's `load()` does nothing because the "constraint" is baked into the node numbering, not into matrix stamps. This is the correct final state and requires no further action beyond adding the empty `setup()` method.

Every `AnalogElementCore` must declare a load-order ordinal; `RES` is the lowest-priority bucket, appropriate for a no-op element.

## Verification gate

1. Any test exercising Ground in analog mode remains GREEN (no regression from adding an empty `setup()` method).
2. Existing test file `src/solver/analog/__tests__/behavioral-remaining.test.ts` is GREEN (per 02-behavioral.md per-task verification gate table — Ground falls into the per-group default test file since no dedicated `behavioral-ground.test.ts` exists).
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. `Grep "allocElement" src/components/io/ground.ts` returns zero matches — Ground has never called `allocElement` and must not start now.
4. No banned closing verdicts.
