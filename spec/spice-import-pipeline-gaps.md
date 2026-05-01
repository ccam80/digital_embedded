# SPICE `.SUBCKT` → digiTS Analog Compile Pipeline- Wiring Gaps

**Status:** Surfaced 2026-04-25 during Phase 10 Wave 10.6 (op-amp inverting parity).
**Trigger:** Wave 10.6 test failed at step=0 iter=0 because the harness silently
dropped the `RealOpAmp` element from the ngspice deck. Investigating a real-opamp
replacement via the SPICE import path (the user-selected approach) revealed that
the parse → compile → emit pipeline is half-wired: the parser exists, the
`applySpiceSubcktImportResult` exists, but the data they produce is not fully
consumed downstream. A real-world published opamp `.subckt` cannot currently
land as identical primitives on both digiTS and ngspice sides.

## Goal

A single source-of-truth `.subckt` (a real published opamp macromodel- not a
behavioral stand-in) that:

- digiTS parses via the existing `model-parser.ts` pipeline.
- digiTS instantiates as a composite `MnaModel` whose internal transistors
  carry the `.MODEL` parameters declared inside the `.subckt`.
- The harness re-emits to ngspice as a syntactically equivalent `.subckt`
  block + `X` instance, so ngspice simulates bit-exact the same primitives.

When this lands, Wave 10.6 becomes a real opamp parity test and the F4c
"self-compare only" carve-out for `real-opamp` is no longer the load-bearing
excuse for the wave.

## The four gaps

### Gap 1- Parser does not recognize controlled-source primitives

**File:** `src/solver/analog/model-parser.ts:42`

```ts
type: "R" | "C" | "L" | "D" | "Q" | "M" | "J" | "X" | "V" | "I";
```

`E` (VCVS), `G` (VCCS), `F` (CCCS), `H` (CCVS) are not in the union and are
also not in `VALID_ELEMENT_PREFIXES` (line 349-351). `parseSubcircuit`
**throws** on the first unknown prefix:

```ts
throw { line: lineNo, message: `Unknown element prefix "${prefix}" on line: ${trimmed}` };
```

Most published opamp macromodels (e.g. the ngspice-bundled `OPAMP1` in
`ref/ngspice/examples/Monte_Carlo/OpWien.sp:58-68`) use `E` sources for the
gain stage and output buffer. They throw on parse before any other gap fires.

**What needs to land:**
- Extend `ParsedElement.type` to include `E | G | F | H`.
- Extend `VALID_ELEMENT_PREFIXES`.
- Add element-line parsing for the four controlled-source forms:
  - `E<name> n+ n- nc+ nc- gain` and `E<name> n+ n- POLY(d) nc1+ nc1- ... coeffs`
  - `G<name> n+ n- nc+ nc- transconductance`
  - `F<name> n+ n- vname gain` (current sense via voltage source instance)
  - `H<name> n+ n- vname transresistance`
- Decide POLY support scope: linear-only is enough for the current test if we
  pick a simple macromodel; document the restriction explicitly with a parser
  error rather than silently truncating.

### Gap 2- `.SUBCKT`-element typeId mapping hardcodes one variant per prefix

**File:** `src/app/spice-import-dialog.ts:324-338`

```ts
function elementTypeId(type: string): string {
  switch (type) {
    case "Q": return "NpnBJT";
    case "M": return "NMOS";
    case "J": return "NJFET";
    ...
  }
}
```

The mapping ignores the actual device type from the matching inline `.MODEL`
card. A `.subckt` with `Q1 ... QPMOD` where `QPMOD` is `.MODEL QPMOD PNP(...)`
maps to `NpnBJT` and silently behaves as the wrong polarity. Same for PMOS
and P-JFET.

**What needs to land:**
- After parsing, build a model-name → device-type map from the parsed
  `.MODEL` cards (and any external `.MODEL`s in scope).
- Resolve typeId from the modelName lookup, not from the prefix character.
- Decide the deterministic fallback when a model name doesn't resolve to a
  parsed `.MODEL` (currently silently mis-maps; must throw or warn loudly).

### Gap 3- `modelRef` and inline `.MODEL` cards are dropped before compile

**Files:**
- `src/app/spice-import-dialog.ts:142-167`- builds `MnaSubcircuitNetlist` but
  **never copies `sc.models`** (the parsed `.MODEL` cards from inside the
  `.SUBCKT`) into the netlist.
- `src/core/mna-subcircuit-netlist.ts`- `MnaSubcircuitNetlist` has no field
  for inline models.
- `src/solver/analog/compiler.ts`- `compileSubcircuitToMnaModel` reads the
  per-element model key as `subEl.params?.model`. The dialog stores the model
  name in `subEl.modelRef` (different field). Result: the compiler always
  falls back to `leafDef?.defaultModel`. Whatever parameters the `.subckt`
  declared in its `.MODEL` cards are unreachable from the compile path.

**What needs to land:**
- Extend `MnaSubcircuitNetlist` with an inline-model dictionary (modelName →
  parsed params + device type), or a registered `ModelEntry` per sub-element.
- In the dialog (and any equivalent test-only entry point we add), populate
  it from `sc.models`.
- In `compileSubcircuitToMnaModel`, resolve the sub-element's model from
  `subEl.modelRef` against the inline dictionary first, then the registry's
  registered models, then `defaultModel`. Whichever path resolves should pass
  the resolved params through to the leaf factory's seed `PropertyBag`.
- Audit `applySpiceSubcktImportResult` (`spice-model-apply.ts:91-120`) for
  the same propagation.

### Gap 4- Netlist generator does not emit subcircuit instances

**File:** `src/solver/analog/__tests__/harness/netlist-generator.ts`

`ELEMENT_SPECS` (lines 21-39) lists only flat primitives. Any host element
backed by a `kind: "netlist"` model entry (i.e. a subcircuit-modeled
component, e.g. a `RealOpAmp` after a `.subckt` is applied) falls through
the prefix-lookup at line 67 and is skipped entirely (`continue`). ngspice
gets a deck missing the host element's contribution- exactly the silent
drop that produced the Wave 10.6 divergence.

**What needs to land:**
- Detect subcircuit-modeled top-level elements (the host element type plus
  its currently-selected `model` property pointing to a `kind: "netlist"`
  entry in `circuit.metadata.models[typeId][modelName]`).
- For each unique `(typeId, modelName)` pair encountered, emit one
  `.subckt <modelName> <port-list>` block whose body lines are reconstructed
  from the inline elements and inline `.MODEL` cards stored on the
  `MnaSubcircuitNetlist`. Pin/port ordering must match the host's pin layout
  one-for-one (so the `X<label>` instance line connects outer node IDs in
  the right order).
- For each instance, emit `X<label> n1 n2 ... <modelName> [params]` using
  the host element's `pinNodeIds`.
- The generator currently takes `(compiled, elementLabels, title)`; it will
  need access to `circuit.metadata.models` (and possibly the registry) to
  resolve subcircuit netlists. Decide signature: pass the `Circuit` directly,
  or pass a resolved `Map<typeId+model, MnaSubcircuitNetlist>` built by the
  caller.

## Cross-cutting decisions to make before coding

1. **Scope of E/G/F/H.** Linear-only is enough for one simple macromodel and
   covers OPAMP1. POLY support is genuinely complex (per-element polynomial
   evaluation in our MNA stamps) and probably out of scope here.
2. **External `.MODEL` libraries.** Some published opamp macromodels reference
   `.MODEL D1N914 D(...)` from a separate library file. Decide whether the
   first cut requires all `.MODEL`s inline, or whether the harness loads a
   sibling library file. Inline-only is the smaller scope.
3. **Where the test plumbs the import.** The dialog is GUI. The harness
   needs a non-GUI path: probably a small helper in
   `src/solver/analog/__tests__/harness/` that does
   `parseSubcircuit → buildNetConnectivity → MnaSubcircuitNetlist (with inline
   models) → applySpiceSubcktImportResult` so the test fixture is just a
   `.dts` plus a sibling `.cir` file.
4. **What macromodel to use.** A 5–9 BJT textbook opamp avoids gap-1 entirely
   (no controlled sources). A Boyle-style macromodel (e.g. OPAMP1) needs
   gap-1 fixed but is shorter. Pick one before sizing the work.
5. **Validation pass.** Before declaring this done, write a smoke test that
   round-trips a small `.subckt` through both engines (parse → digiTS
   compile → digiTS solve; emit → ngspice solve) and asserts the same node
   voltages at DC-OP. That smoke test is the gate before W10.6 itself can be
   re-run.

## Why this is bigger than W10.6

Phase 10 Waves 10.4 (BJT) and 10.8 (MOSFET) are simulating discrete devices
that don't exercise this pipeline. But the broader project goal- being able
to drop a published part's SPICE model into the simulator- depends on every
gap above being closed. The Wave 10.6 failure is a useful surfacing event;
shipping the fix once unblocks all later macromodel-shaped acceptance tests
and any future component whose realistic model is a `.subckt`.
