# Task PB-SUBCKT

**digiTS file:** `src/components/subcircuit/subcircuit.ts`
**Architecture:** composite- generic recursive forwarder. The subcircuit composite carries a `subElements: AnalogElement[]` array constructed by `compileSubcircuitToMnaModel` (`src/solver/analog/compiler.ts:200-379`). `setup()` forwards to every sub-element in `ngspiceLoadOrder` bucket order. `load()` forwards in the same order.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Each sub-element within the subcircuit carries its own map (set when the sub-element's factory is called by `compileSubcircuitToMnaModel`).

The subcircuit's external port pins are bound to internal sub-element nodes via the existing port-binding mechanism (`compiler.ts:262`, `bindings: Map<string, Array<{ el; key }>>`). This mechanism survives unchanged- sub-elements are constructed at compile time so bind targets exist; their internal-node IDs become valid only after setup, but `setParam` doesn't care about node IDs.

## Sub-element decomposition

The subcircuit is generic- its exact sub-elements depend on the circuit definition. The compiler (`compileSubcircuitToMnaModel`) constructs them at compile time from the subcircuit's internal netlist. Sub-elements may include any combination of:

- Primitive elements (RES, CAP, IND, DIO, BJT, SW, VCVS, VCCS, CCCS, CCVS, VSRC, ISRC)
- Nested composite elements (other subcircuits, opamps, etc.)

Each sub-element is an `AnalogElement` with its own `setup()`, `load()`, `ngspiceLoadOrder`, and state slots.

**`subElements` array sorting:** The array is sorted by `ngspiceLoadOrder` at compile time (in `compileSubcircuitToMnaModel`), matching ngspice's `cktsetup.c:72-81` walk of `DEVices[]`.

## Construction (compiler-driven, not user-visible factory)

```ts
// compiler.ts:compileSubcircuitToMnaModel (lines 200-379)
// Returns a CompositeSubcircuitElement with:
//   - subElements: AnalogElement[] (sorted by ngspiceLoadOrder)
//   - portBindings: Map<string, number> (external port → internal MNA node)
//   - paramBindings: bindings (for setParam forwarding)

const composite = new SubcircuitCompositeElement({
  subElements,          // sorted by ngspiceLoadOrder
  portBindings,         // external pin label → internal node ID
  paramBindings,        // setParam key → sub-element dispatch
  label,
});
```

The factory registered on `SubcircuitDefinition.modelRegistry` wraps `compileSubcircuitToMnaModel` and returns this composite element. The factory signature (per A6.3) is `(pinNodes, props, getTime)`- 3 parameters, no `internalNodeIds` or `branchIdx`.

## setup() body- recursive forward in load-order

```ts
setup(ctx: SetupContext): void {
  // Forward to each sub-element in ngspiceLoadOrder bucket order.
  // This is the direct port of cktsetup.c:72-81's walk of DEVices[].
  for (const el of this._subElements) {
    el.setup(ctx);
  }
  // No composite-level state slots (subcircuit has no behavioral state of its own).
  // All state allocation is owned by sub-elements' setup() calls.
}
```

The order is deterministic: `_subElements` is already sorted by `ngspiceLoadOrder` at compile time. No secondary sort in `setup()` is needed.

## load() body- recursive forward

```ts
load(ctx: LoadContext): void {
  for (const el of this._subElements) {
    el.load(ctx);
  }
}
```

## State slots

Composite has none of its own. All state slots are owned by sub-elements via their own `setup()` calls. The total state count for a subcircuit instance is the sum of `stateSize` across all sub-elements- this is computed at `setup()` time, not compile time.

## findDevice usage

Subcircuits MAY need `findDevice` for cross-element references within the subcircuit boundary. Specifically:

- **CCCS within subcircuit**: if a CCCS references a controlling VSRC by label, `ctx.findDevice(senseSourceLabel)` is called during the CCCS's `setup()` to resolve the controlling branch. The composite does not call `findDevice` itself- the sub-element (CCCSElement) does.
- **CCVS within subcircuit**: same pattern.
- **MUT (mutual inductance) within subcircuit**: `ctx.findDevice(inductorLabel)` called by the MUT element's `setup()`.

The subcircuit composite holds direct refs to sub-elements in `_subElements`; it does NOT call `findDevice` for sub-element traversal. `findDevice` is only needed when a sub-element's own setup logic requires cross-device lookup by label.

**`_deviceMap` population:** Subcircuit sub-elements are auto-inserted into `_deviceMap` with namespaced labels by the engine's recursive `init()` walk (see `00-engine.md` ssA4.1). Internal cross-device references inside the subcircuit (e.g., a CCCS whose `senseSourceLabel` is `mySubckt/innerVSRC`) resolve via `ctx.findDevice("mySubckt/innerVSRC")`- note the `/` separator matching the project's addressing scheme. The compiler's `compileSubcircuitToMnaModel` should emit the namespaced label using `/` (not `_`) to match the engine's `_deviceMap` keying.

## Port-binding mechanism (compiler.ts:262)

```ts
// bindings: Map<string, Array<{ el: AnalogElement; key: string }>>
// Built at compile time by compileSubcircuitToMnaModel.
// Survives unchanged through the setup/load split migration.
//
// Usage: when the subcircuit's setParam is called with a port-binding key,
// the composite forwards to each bound sub-element:
setParam(key: string, value: number): void {
  const targets = this._paramBindings.get(key);
  if (targets) {
    for (const { el, key: elKey } of targets) {
      el.setParam(elKey, value);
    }
  }
}
```

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from the factory signature returned by `compileSubcircuitToMnaModel` (per A6.3).
- The compiled subcircuit's factory signature becomes `(pinNodes, props, getTime)`.
- `mayCreateInternalNodes: true`- subcircuits commonly contain DIO, BJT, MOS sub-elements that create internal nodes in their own `setup()`.
- Leave `ngspiceNodeMap` undefined on the `SubcircuitDefinition` composite.
- No compile-time `matrixSize`, `branchCount`, or `internalNodeCount` computation (per A6.1-A6.2). All matrix structure deferred to `setup()`.

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
