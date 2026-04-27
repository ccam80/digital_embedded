# Task PB-OPAMP

**digiTS file:** `src/components/active/opamp.ts`
**Architecture:** composite. Decomposes into 1 sub-element at compile time.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap` (composites don't stamp directly). Each sub-element carries its own map; listed below.

Composite pin labels (from `buildOpAmpPinDeclarations()`):
- `in-` — inverting input (pinLayout index 0)
- `in+` — non-inverting input (pinLayout index 1)
- `out` — output (pinLayout index 2)

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent pin → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `vcvs1` | VCVSElement | `vcvs/vcvsset.c:53-58` | `in+` → `ctrl+`, `in-` → `ctrl-`, `out` → `out+`, ground(0) → `out-` | `"gain"` → vcvs1 |

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

The current implementation uses a Norton approximation (conductance + current source). After migration, the output stage switches to a true VCVS stamp matching `vcvsset.c:53-58` so that `setup-stamp-order.test.ts` passes. The existing `rOut` parameter becomes the series output resistance modelled via an additional RES sub-element (`res1`) if `rOut > 0`.

### Extended decomposition with rOut

| Sub-element label | Class | ngspice anchor | Pin assignments | setParam routing |
|---|---|---|---|---|
| `vcvs1` | VCVSElement | `vcvs/vcvsset.c:53-58` | `in+`→`ctrl+`, `in-`→`ctrl-`, `vint`(internal)→`out+`, `0`→`out-` | `"gain"` → vcvs1 |
| `res1` | RESElement | `res/ressetup.c:46-49` | `vint`(internal)→`A`, `out`→`B` | `"rOut"` → res1 |

Where `vint` is an internal node allocated by `ctx.makeVolt(label, "vint")` during `setup()`. This node serves as the ideal voltage source output; `res1` drops the output impedance between `vint` and `out`.

**Simplified model (rOut == 0):** `vint` collapses to `out`; `res1` omitted.

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

## setup() body — composite forwards

```ts
setup(ctx: SetupContext): void {
  const inP  = this._pinNodes.get("in+")!;
  const inN  = this._pinNodes.get("in-")!;
  const nOut = this._pinNodes.get("out")!;

  if (this._rOut > 0) {
    // Allocate internal voltage node between ideal source and output resistance
    this._vint = ctx.makeVolt(this.label, "vint");
    // vcvs1: ctrl+(in+), ctrl-(in-), out+(vint), out-(0)
    this._vcvs1.pinNodeIds = [inP, inN, this._vint, 0];
    this._vcvs1.setup(ctx);
    // res1: A(vint), B(out)
    this._res1!.pinNodeIds = [this._vint, nOut];
    this._res1!.setup(ctx);
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
- Add `hasBranchRow: false` on the composite's `MnaModel` (sub-elements register their own `hasBranchRow: true`).
- Add `mayCreateInternalNodes: true` (when `rOut > 0`, `setup()` calls `ctx.makeVolt`).
- Leave `ngspiceNodeMap` undefined on the composite `ComponentDefinition`.
- `defaultModel: "behavioral"` remains for initial placement only.

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

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-OPAMP is GREEN.
2. `src/components/active/__tests__/opamp.test.ts` is GREEN.
3. The pin-map-coverage test allows the composite to lack `ngspiceNodeMap`.
4. No banned closing verdicts.
