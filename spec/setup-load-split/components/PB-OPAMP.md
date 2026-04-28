# Task PB-OPAMP

**digiTS file:** `src/components/active/opamp.ts`
**Architecture:** composite. Decomposes into 1 sub-element at compile time.

> **Spec status note (2026-04-28):** This PB describes a target architecture in
> which the op-amp owns concrete `VCVSElement` and `RESElement` sub-element
> objects and rebinds them via `pinNodeIds = [...]` in `setup()`. The current
> `opamp.ts` implementation does **not** instantiate those sub-element objects —
> it inlines the VCVS+RES TSTALLOC sequences directly into a single closure-
> backed `AnalogElementCore`. The `pinNodeIds = [...]` listing in the
> "setup() body" section below is therefore aspirational; it will become
> reachable code only once the sub-element refactor lands. For sub-element
> wiring of any element whose `setup()` reads from `_pinNodes` (BJT in
> particular), the canonical pattern is `_pinNodes.set(...)` direct
> mutation — see PB-OPTO, PB-TIMER555, PB-SCR.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap` (composites don't stamp directly). Each sub-element carries its own map; listed below.

Composite pin labels (from `buildOpAmpPinDeclarations()`):
- `in-` — inverting input (pinLayout index 0)
- `in+` — non-inverting input (pinLayout index 1)
- `out` — output (pinLayout index 2)

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments | setParam routing | Conditional |
|---|---|---|---|---|---|
| `vcvs1` | VCVSElement | `vcvs/vcvsset.c:53-58` | `in+`→`ctrl+`, `in-`→`ctrl-`, `vint`(internal)→`out+`, `0`→`out-` | `"gain"` → vcvs1 | Always present |
| `res1` | RESElement | `res/ressetup.c:46-49` | `vint`(internal)→`A`, `out`→`B` | `"rOut"` → res1 | Present only when `rOut > 0`; omitted entirely when `rOut = 0` (and `vint` is not allocated; `vcvs1` connects directly to `nOut`) |

Sub-element `ngspiceNodeMap`:
```
vcvs1.ngspiceNodeMap = {
  "ctrl+": "contPos",
  "ctrl-": "contNeg",
  "out+":  "pos",
  "out-":  "neg",
}
```

The ideal op-amp output negative node is ground (0). The VCVS stamps `(out, 0)` as `(posNode, negNode)`.

Where `vint` is an internal node allocated by `ctx.makeVolt(label, "vint")` during `setup()`. This node serves as the ideal voltage source output; `res1` drops the output impedance between `vint` and `out`.

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const inP  = pinNodes.get("in+")!;
  const inN  = pinNodes.get("in-")!;
  const nOut = pinNodes.get("out")!;
  const gain = props.getModelParam<number>("gain") ?? 1e6;
  const rOut = props.getModelParam<number>("rOut") ?? 75;

  const vcvs1 = new VCVSElement(gain);
  vcvs1.label = `${label}_vcvs1`;
  // pin assignment deferred — node IDs resolved in setup()

  const res1 = rOut > 0 ? new RESElement(rOut) : null;
  if (res1) res1.label = `${label}_res1`;

  return new OpAmpCompositeElement({ vcvs1, res1, inP, inN, nOut, gain, rOut });
}
```

**Default rOut=75 — behavioral change warning (FOPAMP-D2 resolution)**

Default `rOut=75` introduces a 75Ω series output resistance that is NOT present in the current Norton-based PB-OPAMP implementation. Any test circuit with a load at `out` will see ~75Ω·I_load voltage drop post-migration. The implementer must:

1. Run `opamp.test.ts` BEFORE making any change. Record which assertions pass.
2. After applying this spec, run `opamp.test.ts` again.
3. For each test that fails because of the 75Ω drop, the implementer REPORTS (not silently fixes) the regression. The user decides whether to:
   - Update the test assertion to expect the post-migration behavior (`actualVoltage = expectedVoltage - rOut * loadCurrent`), OR
   - Change the default to `rOut=0` (no series resistance unless user opts in), OR
   - Some other resolution.

The 75Ω value is from the existing OPAMP implementation's modeling intent (real op-amps have nonzero output impedance). It is preserved here so that circuits using realistic OPAMP defaults benefit from the corrected output-impedance model. The trade-off (test regression vs. behavioral fidelity) is the user's to make.

```ts
```

## setup() body — composite forwards

Sub-element ordering follows the engine's §A6.4 'Sub-element ordering rule' (NGSPICE_LOAD_ORDER ordinal ascending).

```ts
setup(ctx: SetupContext): void {
  const inP  = this._pinNodes.get("in+")!;
  const inN  = this._pinNodes.get("in-")!;
  const nOut = this._pinNodes.get("out")!;

  if (this._rOut > 0) {
    // Allocate internal voltage node between ideal source and output resistance
    this._vint = ctx.makeVolt(this.label, "vint");
    // RES first (NGSPICE_LOAD_ORDER.RES = 1): res1: A(vint), B(out)
    this._res1!.pinNodeIds = [this._vint, nOut];
    this._res1!.setup(ctx);
    // VCVS last (NGSPICE_LOAD_ORDER.VCVS = 47): vcvs1: ctrl+(in+), ctrl-(in-), out+(vint), out-(0)
    this._vcvs1.pinNodeIds = [inP, inN, this._vint, 0];
    this._vcvs1.setup(ctx);
  } else {
    // vcvs1: ctrl+(in+), ctrl-(in-), out+(out), out-(0)
    this._vcvs1.pinNodeIds = [inP, inN, nOut, 0];
    this._vcvs1.setup(ctx);
  }
}
```

## load() body — composite forwards

```ts
load(ctx: LoadContext): void {
  this._vcvs1.load(ctx);
  if (this._res1) this._res1.load(ctx);
}
```

## State slots

Composite has none of its own. Sub-elements own their state slots via their own `setup()`.

- VCVSElement: `NG_IGNORE(states)` at `vcvsset.c:26` — no state slots.
- RESElement: no state slots.

## findDevice usage

Not needed. Composite holds direct refs to `_vcvs1` and `_res1`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Add `mayCreateInternalNodes: true` (when `rOut > 0`, `setup()` calls `ctx.makeVolt`).
- Leave `ngspiceNodeMap` undefined on the composite `ComponentDefinition`.
- Set `defaultModel: "behavioral"`.

## VCVS TSTALLOC sequence (vcvsset.c:53-58) — for stamp-order verification

When `vcvs1.setup(ctx)` runs with nodes `(ctrl+, ctrl-, out+, out-)` = `(inP, inN, vint, 0)`:

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `VCVSposIbrptr` | `VCVSposNode` (vint) | `VCVSbranch` | `_vcvs1._hPosIbr` |
| 2 | `VCVSnegIbrptr` | `VCVSnegNode` (0/gnd) | `VCVSbranch` | `_vcvs1._hNegIbr` |
| 3 | `VCVSibrPosptr` | `VCVSbranch` | `VCVSposNode` (vint) | `_vcvs1._hIbrPos` |
| 4 | `VCVSibrNegptr` | `VCVSbranch` | `VCVSnegNode` (0/gnd) | `_vcvs1._hIbrNeg` |
| 5 | `VCVSibrContPosptr` | `VCVSbranch` | `VCVScontPosNode` (inP) | `_vcvs1._hIbrCP` |
| 6 | `VCVSibrContNegptr` | `VCVSbranch` | `VCVScontNegNode` (inN) | `_vcvs1._hIbrCN` |

Branch row allocated via `ctx.makeCur(label+"_vcvs1", "branch")` before TSTALLOC.

## Pre-implementation checklist (W3 implementer)

1. Run `npm run test:q -- opamp` — capture baseline pass/fail counts.
2. Identify any `expect(vOut).toBeCloseTo(...)` assertions for circuits with non-trivial load at `out`. The 75Ω rOut may shift these by `75Ω * loadCurrent`.
3. After implementation, re-run; report any new failures for user review. Do NOT silently update assertions to match new behavior — escalate.

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
