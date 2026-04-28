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

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body — alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only — zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
