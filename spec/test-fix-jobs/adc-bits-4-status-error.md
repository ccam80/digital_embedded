# ADC bits=4 sweep — status-bar error on compile

**Category:** `architecture-fix`

## Problem statement

`e2e/gui/component-sweep.spec.ts > 5B — Bit-Width Variation Sweep > ADC at
bits=4: set property and compile` fails with a status-bar error after
`stepViaUI()`. The companion case `ADC at bits=8` is reported as failing
too in the broader brief, but the dispatch scope here is the bits=4 case
only; the architectural diagnosis below applies to both.

## Sites

### Test
- `e2e/gui/component-sweep.spec.ts:530-595` — generic width-sweep test
  body. For each `WidthTestEntry`, places one DUT, sets the width
  property, wires `SRC In → DUT.inputPin` and `DUT.outputPin → DST Out`
  according to `resolveTestPins`. The width matrix entry for ADC is at
  line 181: `{ type: 'ADC', propKey: 'bits', widths: [4, 8] }`.
- `e2e/gui/component-sweep.spec.ts:280-283` — `resolveTestPins` for
  ADC: `inputPin: ''` (no `In` placed/wired), `outputPin: 'D0'`,
  `srcWidth: width`, `dstWidth: 1`. The empty `inputPin` means
  `placeLabeled('In', ...)` is skipped (test body line 549), so ADC's
  `VIN`/`CLK`/`VREF`/`GND` pins are all unwired.
- `e2e/gui/component-sweep.spec.ts:572-578` — DAC's per-component
  extras block: explicitly places `Vref` (DcVoltageSource → DAC.VREF)
  and `Ground` (→ DAC.GND) so the DAC's analog model can compile.
  **No equivalent block exists for ADC.** The ADC's `VREF`, `GND`,
  `VIN`, `CLK` pins go unwired into compile.

### Production component
- `src/components/active/adc.ts` — full ADC composite element.
  Pin layout from `buildADCPinDeclarations(bits)` at lines 118-188:
  `VIN`, `CLK`, `VREF`, `EOC`, `D0..D(N-1)`, `GND`. The analog model
  `ADCAnalogElement` reads `VIN`, `VREF`, `GND` directly from the MNA
  RHS at lines 379-381:
  ```ts
  const vIn  = rhs[this._nVin];
  const vRef = rhs[this._nVref];
  const vGnd = rhs[this._nGnd];
  ```
  with `this._nVref = pinNodes.get("VREF") ?? 0`, etc. (lines 252-256).
  When the pins are unwired, `pinNodes.get("VREF")` returns `undefined`
  and `_nVref = 0` (the ground/reference node). All three reads then
  collapse to the same node and the conversion at line 384-393:
  ```ts
  const span = vRef - vGnd;
  if (span <= 0) return 0;
  ```
  triggers the early-return, which is fine *behaviourally* (the ADC
  outputs code 0). The status-bar error therefore is NOT from the
  conversion math.

### Status-bar emission path
- `e2e/fixtures/ui-circuit-builder.ts:959-964` — `verifyNoErrors()` only
  reads the status-bar `.error` class. The actual error message is
  dispatched in `src/app/...` (status-bar updater bound to engine
  diagnostics).

## Diagnosis

The ADC at `bits=4` instantiates an `ADCAnalogElement` with **5
`DigitalOutputPinModel`** children (one for `EOC` plus four for
`D0..D3`) and 2 `DigitalInputPinModel` children (`VIN`, `CLK`). The
composite forwards `setup`/`load` to all children via
`CompositeElement.getSubElements()` per `adc.ts:283-291`.

When the test runs:
1. `stepViaUI()` triggers compile + first DC-OP step.
2. Compile builds the analog partition.
3. `topologyInfo` is recorded and the validator is invoked with
   `branchIndex = -1` for every element (the
   `topology-validation-after-setup.md` defect — pre-flight validation
   sees stale data and emits no diagnostics here).
4. The engine starts NR.
5. Inside `ADCAnalogElement.load`, the four output pins
   `D0..D3` each call their `DigitalOutputPinModel.load` which stamps a
   Norton-equivalent voltage source into the unwired `D0..D3` nets. The
   one wired output is `D0` → `DST.in`; `D1`, `D2`, `D3` are floating.
6. Each floating output pin's Norton stamp creates a one-cell
   conductance from the floating node to its synthetic Thevenin
   reference. With nothing else attached, each floating node forms a
   one-conductor isolated subnet — a singularity in the MNA matrix.
7. The LU factorizer hits singularity, the engine emits a singular-
   matrix diagnostic, the diagnostic is routed to the status-bar
   updater, the status bar flips red.

This explains why the test fails: the ADC has 5 outputs, only 1 is
wired, the other 4 produce floating output drives, and the matrix is
structurally singular.

The sister DAC test does not hit this because:
- DAC has only 1 analog output (`OUT`) plus internal digital inputs
  driven by `In` components. With `OUT` wired (per
  `resolveTestPins:276-278` returning `outputPin: ''` for DAC, but
  `srcWidth: 1` indicating a wired digital input), and the test
  explicitly wires VREF and GND (lines 572-578), no analog node
  floats.

## ngspice citation — honest framing

ngspice does not ship an ADC primitive. The XSPICE extension
(`ngspice/src/xspice/icm/digital/`) has behavioural ADC models but
those are out-of-tree from the core simulator and do not share the
ngspice device-load convention. The digiTS ADC at
`src/components/active/adc.ts` is a digiTS-original behavioural
composite, not a port of any ngspice device.

The relevant ngspice infrastructure citation is the singular-matrix
detection path:
- `ref/ngspice/src/maths/sparse/spfactor.c:260-262` — `pPivot == NULL`
  → `MatrixIsSingular`. Verified verbatim against local checkout.
- `ref/ngspice/src/maths/ni/niiter.c:885-905` — `E_SINGULAR` retry
  loop:
  ```c
  if(error) {
      SMPgetError(ckt->CKTmatrix,&i,&j);
      SPfrontEnd->IFerrorf (ERR_WARNING,
          "singular matrix:  check nodes %s and %s\n",
          NODENAME(ckt,i), NODENAME(ckt,j));
      ...
      return(error);
  }
  ```
  Verified verbatim. ngspice catches the same shape (floating subnet)
  via `E_SINGULAR` post-factorization. digiTS's analog engine has the
  equivalent path, which is what the status-bar error reports.

## Architecture diagnosis (production fix)

Two architecture-correct fix shapes, in order of preference:

### Fix shape A — high-impedance default for unwired digital outputs

A `DigitalOutputPinModel` whose net has no other connections (no other
elements in the partition stamping into that node) should not stamp
its Norton source — it should fall back to a high-impedance (Hi-Z)
mode. The composite's `setup()` walk could mark each output pin's net
as "isolated" if the partition build saw no other element bound to it,
and the pin's `load()` would skip stamping in that case.

This requires the post-setup topology pass (per
`topology-validation-after-setup.md`) to expose per-net connectivity to
elements. Once that exists, the `DigitalOutputPinModel.load()` short-
circuit on isolated nets is straightforward.

### Fix shape B — emit a clear pre-flight diagnostic for unwired ADC outputs

The post-setup validator could detect "composite element with N output
pins, M (M < N) wired to a non-isolated subnet" and emit a
`code: "unwired-output"` diagnostic instead of letting the singular
matrix surface from the LU factorizer. This is friendlier to the user
but does not let the test pass — `verifyNoErrors()` in the test fails
on any status-bar error.

The test contract for the bit-width sweep at
`component-sweep.spec.ts:580-583` is `await builder.stepViaUI(); await
builder.verifyNoErrors();` — meaning the sweep wants a clean compile
even when only one output is wired. Fix shape A is the only path that
satisfies the test as written.

## Required fix sites

### Production — `src/components/active/adc.ts`
- `ADCAnalogElement` should mark its `_digitalPins[i]` and `_eocPin` as
  Hi-Z when the partition build has no other element bound to the
  net. This requires a post-setup hook on the composite that the engine
  calls after building per-net connectivity, OR the
  `DigitalOutputPinModel` itself becomes net-connectivity-aware.

### Production — `src/solver/analog/digital-pin-model.ts`
- `DigitalOutputPinModel.load()` already has a Hi-Z mode (the
  `rHiZ` parameter). The hook to enable Hi-Z when the net is
  isolated is missing. Add a `_isolated` flag set during composite
  setup, and short-circuit `load()` to a `gmin`-only stamp when set.

### Test — `e2e/gui/component-sweep.spec.ts`
No test changes required if production is fixed correctly. If the user
chooses fix shape B (diagnostic + skip-and-pass), the test would need
explicit `Out` placements for D1/D2/D3 — but that is not the
recommended path.

## Resolves

1 e2e test (`Component sweep tests > 5B — Bit-Width Variation Sweep >
ADC at bits=4: set property and compile`).

The same fix likely resolves `ADC at bits=8` (8 output pins, 7 unwired)
and may resolve the analogous floating-output cases for any other
multi-output composite that does not provide its own Hi-Z fallback.

## Tensions / uncertainties

1. **The actual status-bar message is not captured.** The diagnosis
   above identifies a singular-matrix shape as the most likely cause
   given the unwired-output topology, but the actual emitted
   diagnostic could be different (e.g. `unconnected-input` from CLK
   being unwired, `convergence-failed` from NR stalling, etc.). The
   test assertion just checks the `.error` class on the status bar; it
   does not capture the message. **Required to confirm:** extend
   `verifyNoErrors()` to log `#status-bar.textContent` before
   asserting, run the failing test once, capture the message,
   re-evaluate this diagnosis. Until that capture happens, the
   diagnosis is the most consistent with the unwired-output topology
   but is not certain.

2. **The bits=8 case is in scope of the brief but not in the brief's
   "ADC bits=4 (×1)" line.** If only bits=4 fails, the diagnosis
   above is wrong (5 vs 9 unwired outputs would both fail under the
   floating-net theory). If both fail, the theory is consistent. **If
   only bits=4 fails, the cause is more localised** — possibly a code
   path inside `ADCAnalogElement.setup()` that misallocates state for
   `bits=4` specifically (e.g. an off-by-one in the
   `DigitalOutputPinModel` array iteration). Open `adc.ts` lines 252-
   281 with a debugger and inspect the composite's child list at
   `bits=4` to confirm.

3. **Could the test simply be missing the VREF/GND wiring (parallel
   to the DAC)?** That would silence the test by writing the
   environment the ADC actually needs to operate, but it would NOT
   address why the ADC's unwired-output composite fails to compile.
   Per `CLAUDE.md` "No Pragmatic Patches", the production fix is the
   right path: behavioural composite outputs should not produce
   structural singularities just because they are unwired. A
   behavioural component the user has placed but not yet wired should
   compile cleanly and either show no signal on the unwired outputs
   (Hi-Z) or surface a clear diagnostic — never hang or emit an
   opaque status-bar error.

4. **Banned-vocab guard.** This spec uses no closing-verdict
   banned vocabulary. The diagnosis classifies the issue as
   `architecture-fix` (production-side defect requiring per-pin Hi-Z
   awareness) and identifies the dependency on the post-setup
   validation hook. No `tolerance` / `mapping` / `equivalent under` /
   `partial` / `pre-existing` / `intentional divergence` /
   `citation divergence` is used as a verdict.
