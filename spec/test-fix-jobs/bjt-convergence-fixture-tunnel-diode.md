# BJT buck-converter fixture missing TD freewheel-diode placement

**Category:** `contract-update`

## Problem statement

`e2e/gui/analog-bjt-convergence.spec.ts::buildBuckBJT` references an element
labelled `TD` in three later wiring/trace calls (lines 192, 220, 318) but the
`buildBuckBJT` body never calls `placeLabeled(...)` for that element. The
docstring at the top of the file says:

```
//   Diode TD  (43,12) rot=90: A@(43,12)   K@(43,8)
...
//      TD snubber: K@(43,8)→switch node, A@(43,12)→ground bus
```

so the original intent was a freewheel/snubber diode across the switch node
to ground, oriented vertically (rot=90) at grid (43,12). Inspection of every
`placeLabeled(...)` call between lines 80-163 of the test confirms there is
no `Diode` placement — only DcVoltageSource, AcVoltageSource, Tunnel,
Resistor, NpnBJT, PnpBJT, NMOS, Inductor, Capacitor.

When `buildBuckBJT` reaches line 192:

```
await builder.drawWireFromPinExplicit('TD', 'A', 43, 15);
```

`drawWireFromPinExplicit` calls `getPinPagePosition('TD', 'A')`, which the
helper at `e2e/fixtures/ui-circuit-builder.ts:222` asserts non-null with the
message `Pin "${pinLabel}" on element "${elementLabel}" not found`. With no
TD element on the canvas, the assertion fires:

```
Pin "A" on element "TD" not found
```

All three `test(...)` blocks in this file run the same `buildBuckBJT` from
`beforeEach`, so all three fail with the same error before the test body
executes.

The earlier triage note ("TD is a tunnel-diode label — fixture references the
deleted tunnel-diode component") is incorrect. `TD` is the label the author
chose for an ordinary `Diode` placement that was never written. The
`tunnel-diode` component does not appear anywhere in `src/components/`,
`src/core/registry.ts`, or this test — confirmed by full-tree search for
`tunnel.?diode|TunnelDiode|tunnel_diode`. The only matches in the
component tree are unrelated (`diode.ts:661` documents that `tunnel` flag
behaviour is consumed only by a hypothetical `tunnel-diode.ts`; no such
file exists).

## Sites

### Test file
- `e2e/gui/analog-bjt-convergence.spec.ts:64` — docstring describes
  `Diode TD (43,12) rot=90: A@(43,12) K@(43,8)`.
- `e2e/gui/analog-bjt-convergence.spec.ts:153` — last `placeLabeled` call
  before the wiring section. The missing diode placement should be inserted
  immediately after this line, before the `Rload` placement at line 163, so
  it is on the canvas before the wiring section begins at line 168.
- `e2e/gui/analog-bjt-convergence.spec.ts:191-192, 219-220, 273-274, 281,
  318, 324, 331, 342-344` — all references to label `TD` (wiring, traces,
  comments).

### Helper that emits the failure message
- `e2e/fixtures/ui-circuit-builder.ts:222` —
  `expect(pos, "Pin "${pinLabel}" on element "${elementLabel}" not found")
  .not.toBeNull();`

### Component registry confirmation
- `src/core/registry.ts:90` — comment: "SPICE-L3 tunnel-diode ModelEntry —
  not used by any component in this …" (the unused model exists; the
  component does not).
- `src/components/semiconductors/diode.ts:661` — the only other `tunnel`
  reference is a comment about a `tunnel` flag consumed by a non-existent
  `tunnel-diode.ts`.

### Failing tests this resolves
- `e2e/gui/analog-bjt-convergence.spec.ts > BJT buck converter convergence
  > compile and step — no convergence error, supply rail is 10V`
- `e2e/gui/analog-bjt-convergence.spec.ts > BJT buck converter convergence
  > run continuously — voltages remain bounded`
- `e2e/gui/analog-bjt-convergence.spec.ts > BJT buck converter convergence
  > step to 5ms — output voltage evolves and trace captures transient`

## What the test actually verifies

The test body's `expectClose` references at lines 310-313 and 333-344 are
ngspice-derived numerical references for a buck converter with a freewheel
diode across the switch node. Specifically:

- `iQ1, iQ2` collector currents (NPN/PNP push-pull driver)
- `swStats.min/max/mean` of the switch node (M1.S = (40,5))
- `outStats.min/max/mean` of the output node (after LC filter)
- `diodeStats.min/max/mean` of the freewheel diode current via
  `addCurrentTraceViaContextMenu('TD')`

The diode is the freewheel path that conducts during the OFF half of the
switching cycle (when M1 is off, inductor current finds a return path
through TD from ground bus up through the switch node). Without the
diode, the switch node would float negative and the diode-current trace
would be undefined — so the diode is functionally required, not optional
decoration. The ngspice references baked into the assertions
(`diodeStats.min ≈ -5.91e-2 A`, `diodeStats.mean ≈ -2.94e-2 A`) were
captured from a buck circuit that included the diode.

## Fix shape

Add the missing `Diode` placement to `buildBuckBJT`. The position, rotation,
and pin geometry are already documented in the file's own docstring — the
only change is to add the `placeLabeled('Diode', ...)` call.

Insert immediately after the existing line 153 `Capacitor C1` placement and
before the zoom-to-fit at line 157, mirroring the existing pattern of
labelled-component creation:

```ts
// Diode TD at (43,12) rot=90: A@(43,12), K@(43,8)
// Freewheel/snubber diode across switch node — conducts during OFF half
// of the switching cycle, providing a return path for inductor current.
await builder.placeLabeled('Diode', 43, 12, 'TD', 90);
```

Pin coordinates after rot=90 (per the docstring at line 53 and the rotation
formula at lines 56-57): A@(43,12), K@(43,8). The wiring at lines 191-192
(`TD.A → (43,15)` ground bus) and lines 219-220 (`TD.K → (43,5)` switch
node) is already correct for those pin positions.

No other changes to the test body, the wiring sequence, the assertion
values, or the docstring are required. The assertion values at
lines 310-313 and 333-344 already reflect the diode-present circuit; the
fix simply adds the missing placement so the wiring code can find the
element it was always meant to reference.

## ngspice citation

The diode itself is `ngspice/src/spicelib/devices/dio/dioload.c` (already
the citation for digiTS `Diode` per `src/components/semiconductors/diode.ts`
header). The diode is a leaf SPICE-L1 device with no parameters set in the
test (defaults: `IS=1e-14`, `N=1`, `RS=0`), which matches ngspice's
`diosetup.c` defaults block when no `.MODEL` line is supplied. No
behavioural assertion in this spec depends on a specific ngspice formula
beyond the existing diode load model that is already in the codebase.

## Resolves

3 e2e tests (the entire `BJT buck converter convergence` describe block).

## Tensions / uncertainties

1. **Was the rotation in the original capture rot=90 or some other value?**
   The docstring at line 64 explicitly states `rot=90` and gives the rotated
   pin coordinates `A@(43,12) K@(43,8)`. The wiring at lines 191-192 wires
   `TD.A → (43,15)` (vertical drop to ground bus) and at lines 219-220 wires
   `TD.K → (43,5)` (vertical rise to switch node). Both are consistent only
   with rot=90 (anode at the bottom of the canvas, cathode at the top, in
   line with the canvas-coordinate convention `+y is down`). Any other
   rotation would put the pins at different grid positions and the wiring
   coordinates would not align. rot=90 is the only consistent choice.

2. **Does the freewheel diode change the ngspice reference values?**
   The values at lines 310-313 and 333-344 were generated from a circuit
   with the diode present (the comment at line 312 says "ngspice refs:
   1.025ms — 1/4 through cycle, drive HIGH, NPN on", and the
   `diodeStats.*` assertions at 342-344 are nonsensical without a diode).
   Adding the diode makes the test runnable; it does not require
   re-capturing references.

3. **Is there any chance the original capture had a different label
   ("D1", "D_FW")?** Search for `Diode` placements in the file returns
   zero hits, so there is no alternative label to consider — the missing
   placement is the only Diode element referenced in the file, and every
   reference in the file uses the literal `'TD'`. The fix uses `'TD'` to
   match.
