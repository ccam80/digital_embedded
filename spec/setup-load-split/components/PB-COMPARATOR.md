# Task PB-COMPARATOR

**digiTS file:** `src/components/active/comparator.ts`
**Architecture:** composite. Decomposes into 1 VCVS sub-element at compile time, with behavioral saturation applied in `load()`.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-element carries its own map.

Composite pin labels (from `buildComparatorPinDeclarations()`):

**IMPORTANT — pin ordering differs from opamp:**
- `in+` — non-inverting input (pinLayout index 0, position y:-1)
- `in-` — inverting input (pinLayout index 1, position y:1)
- `out` — output (pinLayout index 2)

The comparator's `in+` is at y=-1 and `in-` is at y=+1. This is the *opposite* physical position from the op-amp (which places `in-` at y=-1). The MNA node assignments below must use the correct labels, not positional indices.

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent pin → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `vcvs1` | VCVSElement | `vcvs/vcvsset.c:53-58` | `in+`→`ctrl+`, `in-`→`ctrl-`, `out`→`out+`, `0`→`out-` | high-gain (fixed at 1e6, not user-settable) |

Sub-element `ngspiceNodeMap`:
```
vcvs1.ngspiceNodeMap = {
  "ctrl+": "contPos",
  "ctrl-": "contNeg",
  "out+":  "pos",
  "out-":  "neg",
}
```

The comparator is a high-gain VCVS (gain ~1e6) with output clamping in `load()`. The VCVS sub-element provides the matrix structure; the output saturation is a behavioral override applied in `load()` by clamping the RHS injection when the output would exceed `vOH`/`vOL`.

**Behavioral regression risk (FCOMP-D1, FCOMP-D2 resolution)**

The current PB-COMPARATOR implementation uses a Norton output stage (conductance-only stamps, no VCVS branch). This spec rewrites the output as VCVS+RES. Because `comparator.test.ts` was authored against the Norton model, some assertions may produce different output voltages post-migration. The implementer must:

1. Run `comparator.test.ts` BEFORE making any change. Record which assertions pass.
2. After applying this spec, run `comparator.test.ts` again. Any newly-failing assertion is a regression.
3. For each regression, the implementer must REPORT (not silently fix) before declaring the task complete. The user will decide whether the regression is acceptable (high-gain VCVS saturation behavior is provably equivalent to Norton at steady state) or whether the architecture needs to revert to Norton (Option B from FCOMP-D1).

**Hot field declarations** (FCOMP-D2 resolved): `this._latchActive` is derived in `load()` by reading `ctx.state0[this._stateBase + OUTPUT_LATCH] >= 0.5` — no separate cached field is needed; the value is re-read from state each `load()` call. `this._p.rSat` is declared as a model parameter on PB-COMPARATOR with default `1.0` Ω; users can override via setParam. Add `rSat` to the comparator's parameter list alongside `vOH`, `vOL`, `hysteresis`, and `vos`.

The current open-collector and push-pull implementations use a conductance-only stamp (no VCVS branch). After migration, the VCVS sub-element provides the branch row for the stamp-order test. The saturation behavior is preserved: when `|gain * (V_in+ - V_in-)| > vOH`, the VCVS gain is effectively frozen and a Norton clamp current is injected.

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const inP  = pinNodes.get("in+")!;  // non-inverting input
  const inN  = pinNodes.get("in-")!;  // inverting input
  const nOut = pinNodes.get("out")!;

  const vcvs1 = new VCVSElement(1e6);  // high-gain VCVS
  vcvs1.label = `${label}_vcvs1`;
  vcvs1.pinNodeIds = [inP, inN, nOut, 0];  // ctrl+, ctrl-, out+, out-

  return new ComparatorCompositeElement({ vcvs1, inP, inN, nOut, props });
}
```

## setup() body — composite forwards

```ts
setup(ctx: SetupContext): void {
  const inP  = this._pinNodes.get("in+")!;
  const inN  = this._pinNodes.get("in-")!;
  const nOut = this._pinNodes.get("out")!;

  // Assign sub-element nodes then forward
  this._vcvs1.pinNodeIds = [inP, inN, nOut, 0];
  this._vcvs1.setup(ctx);

  // Composite-level state: hysteresis latch + response-time weight
  this._stateBase = ctx.allocStates(2);
}
```

## load() body — composite forwards with output saturation

```ts
load(ctx: LoadContext): void {
  const vInP = ctx.rhsOld[this._inP];
  const vInN = ctx.rhsOld[this._inN];
  const vDiff = vInP - vInN - this._p.vos;
  const halfHyst = this._p.hysteresis / 2;

  // Update hysteresis latch (state0-backed state)
  // ... latch logic per current comparator.ts:282-295 ...
  // Write updated latch value back: ctx.state0[this._stateBase + OUTPUT_LATCH] = newLatch ? 1.0 : 0.0;

  // Forward to sub-element (stamps VCVS matrix entries)
  this._vcvs1.load(ctx);

  // Apply output clamp: read latch state from ctx.state0
  const latchActive = ctx.state0[this._stateBase + OUTPUT_LATCH] >= 0.5;
  if (latchActive) {
    // Override: inject Norton source to clamp to vOL
    // G[out,out] already stamped by vcvs1; add RHS offset
    ctx.rhs[this._nOut] += this._p.vOL * (1.0 / this._p.rSat);
  }
}
```

## State slots

Composite-level state: 2 slots (allocated in `setup()` via `ctx.allocStates(2)`).

| Slot offset | Name | Description |
|---|---|---|
| `base + 0` | `OUTPUT_LATCH` | Hysteresis latch: 1.0 = output active, 0.0 = inactive |
| `base + 1` | `OUTPUT_WEIGHT` | Response-time blend weight [0.0, 1.0] |

These mirror the existing `SLOT_OUTPUT_LATCH` and `SLOT_OUTPUT_WEIGHT` constants in `comparator.ts`.

## findDevice usage

Not needed. Direct ref to `_vcvs1`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Add `mayCreateInternalNodes: false` (no internal nodes on the comparator composite).
- Leave `ngspiceNodeMap` undefined on the composite `ComponentDefinition`.
- Models `"open-collector"` and `"push-pull"` both decompose to VCVSElement; behavioral difference is in `load()` RHS override.

## VCVS TSTALLOC sequence (vcvsset.c:53-58)

With nodes `(inP, inN, nOut, 0)`:

| # | ngspice pointer | row | col |
|---|---|---|---|
| 1 | `VCVSposIbrptr` | `nOut` | `branch` |
| 2 | `VCVSnegIbrptr` | `0` (gnd) | `branch` |
| 3 | `VCVSibrPosptr` | `branch` | `nOut` |
| 4 | `VCVSibrNegptr` | `branch` | `0` (gnd) |
| 5 | `VCVSibrContPosptr` | `branch` | `inP` |
| 6 | `VCVSibrContNegptr` | `branch` | `inN` |

Note: entry (2) `(0, branch)` — ground row is node 0; `allocElement(0, branch)` is a no-op (ground row not stamped). Entry (4) similarly skipped. VCVSElement.setup() must handle node-0 entries correctly (skip, as ngspice does — ground row is never explicitly stored).

## Pre-implementation checklist (W3 implementer)

1. Run `npm run test:q -- comparator` — capture baseline pass/fail counts.
2. Identify any `expect(out).toBeCloseTo(...)` assertions where the expected value depends on saturation behavior. The Norton→VCVS swap may shift these by µV-to-mV depending on circuit load.
3. After implementation, re-run; report any new failures for user review.

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
