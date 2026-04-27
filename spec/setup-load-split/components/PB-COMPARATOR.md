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
  this._stateOffset = ctx.allocStates(2);
}
```

## load() body — composite forwards with output saturation

```ts
load(ctx: LoadContext): void {
  const vInP = ctx.rhsOld[this._inP];
  const vInN = ctx.rhsOld[this._inN];
  const vDiff = vInP - vInN - this._p.vos;
  const halfHyst = this._p.hysteresis / 2;

  // Update hysteresis latch (pool-backed state)
  // ... latch logic per current comparator.ts:282-295 ...

  // Forward to sub-element (stamps VCVS matrix entries)
  this._vcvs1.load(ctx);

  // Apply output clamp: if latch active → override RHS at nOut
  // (saturated region: clamp output between vOL and vOH)
  if (this._latchActive) {
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
- Add `hasBranchRow: false` on the composite's `MnaModel` (vcvs1 has `hasBranchRow: true`).
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

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-COMPARATOR is GREEN.
2. `src/components/active/__tests__/comparator.test.ts` is GREEN.
3. The pin-map-coverage test allows the composite to lack `ngspiceNodeMap`.
4. No banned closing verdicts.
