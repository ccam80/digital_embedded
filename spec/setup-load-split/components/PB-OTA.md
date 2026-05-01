# Task PB-OTA

**digiTS file:** `src/components/active/ota.ts`
**Architecture:** composite. Decomposes into 1× VCCS sub-element at compile time. Bias-current (Iabc) scaling is applied in `load()` before delegating to the VCCS.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-element carries its own map.

Composite pin labels (from `buildOTAPinDeclarations()`):
- `V+`- non-inverting input (pinLayout index 0)
- `V-`- inverting input (pinLayout index 1)
- `Iabc`- bias current control (pinLayout index 2)
- `OUT+`- output positive (pinLayout index 3)
- `OUT`- output (pinLayout index 4)

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent pin → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `vccs1` | VCCSElement | `vccs/vccsset.c:43-46` | `V+`→`ctrl+`, `V-`→`ctrl-`, `OUT+`→`out+`, `OUT`→`out-` | `"gm"` (dynamic, updated each load()) |

Sub-element `ngspiceNodeMap`:
```
vccs1.ngspiceNodeMap = {
  "ctrl+": "contPos",
  "ctrl-": "contNeg",
  "out+":  "pos",
  "out-":  "neg",
}
```

The `Iabc` pin is read directly from `ctx.rhsOld` in `load()` to derive the effective transconductance `gmEff`. The VCCS sub-element is updated with `gmEff` before each stamp cycle via `vccs1.setParam("gm", gmEff)`.

The `Iabc` pin is a pure voltage-read node; it carries no VCCS stamp entries. The composite does NOT allocate matrix entries for `Iabc`.

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const nVp   = pinNodes.get("V+")!;
  const nVm   = pinNodes.get("V-")!;
  const nOutP = pinNodes.get("OUT+")!;
  const nOutN = pinNodes.get("OUT")!;

  const vccs1 = new VCCSElement(0);  // gm=0 initially; updated each load()
  vccs1.label = `${label}_vccs1`;
  vccs1.pinNodeIds = [nVp, nVm, nOutP, nOutN];  // ctrl+, ctrl-, out+, out-

  return new OTACompositeElement({ vccs1, pinNodes, props });
}
```

## setup() body- composite forwards

```ts
setup(ctx: SetupContext): void {
  const nVp   = this._pinNodes.get("V+")!;
  const nVm   = this._pinNodes.get("V-")!;
  const nOutP = this._pinNodes.get("OUT+")!;
  const nOutN = this._pinNodes.get("OUT")!;

  // Assign pin nodes and forward to VCCS sub-element
  this._vccs1.pinNodeIds = [nVp, nVm, nOutP, nOutN];
  this._vccs1.setup(ctx);
  // vccs1.setup allocates the 4 TSTALLOC entries (vccsset.c:43-46)
  // No state slots needed (VCCS has NG_IGNORE(states))
}
```

## load() body- bias scaling then forward

```ts
load(ctx: LoadContext): void {
  const nIabc  = this._pinNodes.get("Iabc")!;
  const nVp    = this._pinNodes.get("V+")!;
  const nVm    = this._pinNodes.get("V-")!;
  const nOutP  = this._pinNodes.get("OUT+")!;
  const nOutN  = this._pinNodes.get("OUT")!;

  const voltages = ctx.rhsOld;
  const twoVt  = 2 * this._p.vt;

  // Read bias current from Iabc node voltage (V(Iabc) = I_bias numerically)
  const vIabc  = nIabc > 0 ? voltages[nIabc] : 0;
  const iBias  = Math.max(0, vIabc);

  // Compute effective gm at current operating point
  const vDiff  = (nVp > 0 ? voltages[nVp] : 0) - (nVm > 0 ? voltages[nVm] : 0);
  const x      = Math.max(-50, Math.min(50, vDiff / twoVt));
  const tanhX  = Math.tanh(x);
  const sech2  = 1 - tanhX * tanhX;
  const gmRaw  = (iBias / twoVt) * sech2;
  const gmEff  = Math.min(Math.abs(gmRaw), this._p.gmMax);

  // Update VCCS transconductance for this NR iteration
  this._vccs1.setParam("gm", gmEff);

  // Norton constant term: I_out0 - gmEff * vDiff
  const iOut0  = iBias * tanhX;
  const iNR    = iOut0 - gmEff * vDiff;

  // Forward to VCCS (stamps 4 conductance entries via cached handles)
  this._vccs1.load(ctx);

  // RHS injection: Norton constant term at OUT+/OUT-
  if (nOutP > 0) ctx.rhs[nOutP] += iNR;
  if (nOutN > 0) ctx.rhs[nOutN] -= iNR;
}
```

## State slots

Composite has none. VCCS has `NG_IGNORE(states)`- no state slots.

## VCCS TSTALLOC sequence (vccsset.c:43-46)

With nodes `(nVp, nVm, nOutP, nOutN)`:

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `VCCSposContPosptr` | `nOutP` | `nVp` | `_vccs1._hPCP` |
| 2 | `VCCSposContNegptr` | `nOutP` | `nVm` | `_vccs1._hPCN` |
| 3 | `VCCSnegContPosptr` | `nOutN` | `nVp` | `_vccs1._hNCP` |
| 4 | `VCCSnegContNegptr` | `nOutN` | `nVm` | `_vccs1._hNCN` |

## findDevice usage

Not needed. Direct ref to `_vccs1`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Add `mayCreateInternalNodes: false`.
- Leave `ngspiceNodeMap` undefined on `OTADefinition`.

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
