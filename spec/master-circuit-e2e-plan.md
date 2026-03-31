# Master Circuit E2E Test Plan

## Design Intent

### Problem
The existing `mixed-circuit-assembly.spec.ts` (and related analog/digital assembly specs) build 40+ small circuits through `UICircuitBuilder.drawWire()`, which uses a ~250-line heuristic Manhattan autorouter in the test framework. This autorouter fails on complex circuits — producing shorted wires, missing connections, and mangled layouts. The exported debug `.dig` files from failing tests show fundamentally broken circuits.

These E2E tests exist for a critical reason: **headless API tests pass while the browser UI is broken**. Agents claim features work because headless tests pass, but users get a broken experience. The E2E tests enforce that headless and UI remain aligned. They cannot be replaced with headless-only tests.

### Solution: Manual Wire Capture + Explicit Replay

Instead of autorouted wiring, we use a two-phase workflow:

1. **Wire Capture** (`e2e/wire-capture.spec.ts`): Places components programmatically, then pauses for a human to draw wires manually in a headed browser. On resume, captures all wire segments and pin positions, matches them to component pins, and outputs `drawWireExplicit`/`drawWireFromPinExplicit` code.

2. **Explicit Replay** (`e2e/gui/master-circuit-assembly.spec.ts`): Uses the captured wiring code with explicit waypoints — no autorouting. Each wire is either a direct pin-to-pin connection or a pin-to-grid-point tap into an existing wire (for fan-out).

### Key Patterns Discovered

- **Fan-out**: Cannot draw multiple wires FROM a pin that already has a wire (click selects instead of starting wire drawing). Instead, draw the first wire from the source pin, then for subsequent connections start from the DESTINATION pin and route TO a point on the existing wire (wire tap creates junction).

- **Bus wiring**: For signals that fan out to many gates (e.g., input A driving 4 gates), draw one "bus" wire from the source pin through waypoints to the farthest destination. Then tap the bus at intermediate points by starting wires from the unconnected gate pins.

- **Ground avoidance**: Wires to ground components at grid positions can accidentally cross other component pins if they share a column. Place grounds carefully and verify the routing path is clear.

- **Viewport limits**: Components placed beyond ~y=30 may be off-screen. Use `#btn-tb-fit` click before placing components in lower sections, or use a more compact layout.

- **Bit width matching**: Counter output is 4 bits by default — the connected Out component must also be set to 4 bits via `setComponentProperty`.

### New UICircuitBuilder Methods

Added to `e2e/fixtures/ui-circuit-builder.ts`:

- `drawWireExplicit(fromLabel, fromPin, toLabel, toPin, waypoints?)` — Draws a wire between labeled pins with optional intermediate grid waypoints. No autorouting.
- `drawWireFromPinExplicit(fromLabel, fromPin, toGridX, toGridY, waypoints?)` — Draws from a labeled pin to a grid coordinate (for Ground/unlabeled components). 
- `drawWireByPath(points)` — Draws a wire through a sequence of grid coordinates.

### Consolidation Strategy

Three large "master circuits" replace the 40+ small individual tests:

| Master | Domain | Components | Tests |
|--------|--------|-----------|-------|
| Master 1 | Digital | AND, OR, XOR, NOT, D_FF, Counter, 2 Inputs, Clock, Const, 6 Outputs | Gate truth tables, fan-out, sequential logic, counter |
| Master 2 | Analog | DcVoltageSource, SPST Switch, 5 Resistors, Capacitor, OpAmp, NpnBJT, 4 Probes, 3 Grounds | DC operating points, switch control, RC transient, OpAmp buffer, BJT CE bias |
| Master 3 | Mixed | DAC (4-bit), Resistor, Capacitor, VoltageComparator, AND, Counter, Clock, 4 Consts, DcVoltageSource (x2), Out, Probe, 3 Grounds | DAC output, RC filtering, analog-digital threshold, comparator-driven counter |

## Current Status

### Master 1: Digital Logic — PASSING
- All components placed and wired with explicit waypoints
- Truth table verified: AND, OR, XOR, NOT (all 4 input combinations)
- Fan-out from inputs A and B to multiple gates working via bus + tap pattern
- AND output fans out to both AND_Y output and D_FF.D input
- CLK fans out to D_FF.C and Counter.C
- Counter output connected with correct 4-bit width

### Master 2: Analog — IN PROGRESS
- Components placed, layout compacted to fit viewport
- Wiring captured from manual session and translated to explicit code
- Fixes applied: ground positions adjusted to avoid wire crossings, P_CE connection fixed, Rc-Vcc routing fixed
- Circuit compiles (domain=analog, no errors) and simTime advances
- **Remaining issue**: CTRL (In) default value not toggling the switch — divider voltages are ~0. The `setComponentProperty('CTRL', 'Default', 1)` may not be setting the initial value correctly. This is a simulator behavior question, not a test architecture issue. Needs investigation of how In component default values interact with SPST switch during analog simulation.
- Assertions need refinement once voltages are non-zero

### Master 3: Mixed-Signal — NOT STARTED

## Remaining Work

### Master 2: Fix switch control and finalize assertions
1. Investigate why `setComponentProperty('CTRL', 'Default', 1)` doesn't close the switch at simulation start
2. Once divider voltages are correct, verify:
   - Voltage divider: P_DIV ≈ Vs/2 = 2.5V (for equal R1, R2)
   - RC settling: P_RC approaches divider voltage after 5τ
   - OpAmp buffer: P_AMP ≈ P_RC (unity gain voltage follower)
   - BJT CE: P_CE between 0 and Vcc depending on bias
3. Remove debug logging (`console.log` calls, `page.pause()`)

### Master 3: Build and wire
1. Run wire capture: `npx playwright test e2e/wire-capture.spec.ts -g "Master 3" --headed --debug`
2. Wire per the connection list (printed to console):
   - D0-D3 → DAC1.D0-D3 (4 digital const inputs)
   - Vref.pos → DAC1.VREF, Vref.neg → GND(8,8)
   - DAC1.GND → GND(17,22)
   - DAC1.OUT → R1.A
   - R1.B → C1.pos, P_DAC.in, CMP.in+ (3-way fan-out at RC/comparator node)
   - C1.neg → GND(37,20)
   - Vref2.pos → CMP.in- (reference threshold)
   - Vref2.neg → GND(25,32)
   - CMP.out → GA.In_1
   - C_EN.out → GA.In_2
   - GA.out → CNT.en
   - CLK.out → CNT.C
   - CNT.out → Q.in
3. Resume — captured code goes to `circuits/debug/master3-wiring-code.ts`
4. Paste captured code into `master-circuit-assembly.spec.ts` Master 3 test
5. Apply the bus + tap pattern for fan-out connections (start from unconnected pins, tap existing wires)
6. Fix ground positions if wires cross components
7. Add assertions:
   - DAC output: code 10 = 10/16 x 5V ≈ 3.125V
   - RC node settles to DAC voltage after 5τ
   - Comparator: DAC output (3.125V) > Vref2 (2.5V default) → output high
   - Counter increments when comparator output is high

### After all three masters pass
1. Remove debug logging and `page.pause()` calls from all tests
2. Remove or skip the old broken tests:
   - `e2e/gui/mixed-circuit-assembly.spec.ts` (12 tests)
   - Overlapping tests from `digital-circuit-assembly.spec.ts` and `analog-circuit-assembly.spec.ts` that are now covered by the masters
3. Update `e2e/wire-capture.spec.ts` ground positions to match the fixes applied to the master test
4. Consider whether `e2e/debug-viewer.spec.ts` and `e2e/pin-map-discovery.spec.ts` should be kept as utilities (excluded from CI) or removed

## Full E2E Test Inventory (from session start)

### Tier 1: App Shell & Basic UI (37 tests, 5 files) — KEEP
- `app-loads.spec.ts` (7) — canvas, menubar, palette, toolbar, status bar, dark mode
- `simulation-controls.spec.ts` (5) — step, run/stop, fit, undo/redo, speed
- `menu-actions.spec.ts` (7) — file/new, undo/redo, fit, traces, dark mode
- `workflow-tests.spec.ts` (13) — placement, property editing, undo/redo, speed, sliders
- `analog-ui-fixup.spec.ts` (5) — speed control, slider panel, float properties

### Tier 2: Parity / postMessage API (13 tests, 3 files) — KEEP
- `headless-simulation.spec.ts` (5) — AND truth table, read-all-signals, half adder
- `error-handling.spec.ts` (4) — invalid data, empty data, missing test data
- `load-and-simulate.spec.ts` (8) — .dig loading, URL load, round-trip, modelParamDeltas

### Tier 3: Component Coverage (~400 tests, 1 file) — KEEP
- `component-sweep.spec.ts`:
  - **5A Placement Sweep** (~140): every registered type can be placed from palette
  - **5B Bit-Width Variation**: width-configurable components at multiple widths
  - **5C Dual-Engine Sweep**: components that support multiple simulation models (digital/cmos, digital/behavioral, analog/mixed) — places component, sets model, compiles, verifies no error

### Tier 4: Circuit Assembly (40+ tests, 4 files) — REPLACE WITH MASTERS
- `digital-circuit-assembly.spec.ts` (13) — AND, OR, NOT, NAND, XOR, adders, latches, flip-flops, counter, mux
- `analog-circuit-assembly.spec.ts` (15+) — RC, divider, RL, RLC, diode, zener, BJT CE, op-amp
- `mixed-circuit-assembly.spec.ts` (12) — DAC+RC, gate→resistor, PWM, comparator, ADC, 555, servo, BJT→gate, switches, relay
- `analog-rc-circuit.spec.ts` (7) — analog palette, domain detection, RC build/step/voltages

### Tier 5: Feature-Specific (20+ tests, 7 files) — KEEP
- `subcircuit-workflow.spec.ts` (15) + `subcircuit-creation.spec.ts` (5) — subcircuit lifecycle
- `pin-loading-wire-override.spec.ts` (5) — pin loading context menu
- `hotload-params-e2e.spec.ts` (6) — BF hot-load, rOut override
- `spice-import-flows.spec.ts` (7) + `spice-model-panel.spec.ts` (5) — SPICE model UI
- `model-selector.spec.ts` (3) — model dropdown
- `analog-bjt-convergence.spec.ts` (3) — BJT convergence stability
- `diag-analog.spec.ts` (1) — diagnostic

### Utility files (not tests) — KEEP as dev tools, exclude from CI
- `e2e/debug-viewer.spec.ts` — opens .dig files in headed browser for visual inspection
- `e2e/pin-map-discovery.spec.ts` — discovers pin positions for all component types
- `e2e/wire-capture.spec.ts` — component placement + manual wiring capture

## How to Continue with Master 3

### Step 1: Run the wire capture
```bash
npx playwright test e2e/wire-capture.spec.ts -g "Master 3" --headed --debug
```

Components will be placed automatically. The console prints the connection list. Draw wires manually in the browser, then click Resume in the Playwright Inspector.

**Note**: The wire-capture spec for Master 3 still has `CNT_EN` component which was removed from the master test. It was already removed from the master spec but needs to also be removed from the wire-capture spec along with its connection list entry (`Net CNT_en`). Also remove the `Net AND_out: GA.out → CNT.en` since GA.out should connect directly to CNT.en without a separate CNT_EN const.

### Step 2: Review captured code
Output goes to `circuits/debug/master3-wiring-code.ts`. The generated code will have:
- Direct pin-to-pin connections for simple wires
- Fan-out entries using `drawWireFromPinExplicit` pointing to the first waypoint

### Step 3: Translate to master test
Paste the captured code into `master-circuit-assembly.spec.ts` replacing the `// TODO` placeholder in Master 3.

Apply these corrections from lessons learned:
1. For fan-out nets (R1.B → C1.pos + P_DAC + CMP.in+), draw the first wire from the source pin to create the main path, then start subsequent wires from the unconnected destination pins routing back to a point on the existing wire.
2. Check that ground wire paths don't cross other components.
3. Verify ground component positions don't coincide with wire routing channels.

### Step 4: Add assertions
The Master 3 test should verify:

```typescript
// --- Compile and verify ---
await builder.stepViaUI();
await builder.verifyNoErrors();

// Add trace on R1 for DAC output voltage
await builder.addTraceViaContextMenu('R1', 'A');

// Step to 5ms to let RC settle
const result = await builder.measureAnalogPeaks('5m');
expect(result).not.toBeNull();
expect(result!.nodeCount).toBeGreaterThanOrEqual(1);

// DAC output: code 10 (D3=1,D2=0,D1=1,D0=0) = 10/16 × 5V ≈ 3.125V
const maxPeak = Math.max(...result!.peaks);
expect(maxPeak).toBeGreaterThan(2.8);
expect(maxPeak).toBeLessThan(3.5);

// Comparator: 3.125V > 2.5V ref → output high → AND enabled → counter counts
// (Counter verification via output value would require reading digital output state)
```

### Step 5: Run and iterate
```bash
npx playwright test e2e/gui/master-circuit-assembly.spec.ts -g "Master 3"
```

If wiring issues appear, run headed with pause:
```bash
npx playwright test e2e/gui/master-circuit-assembly.spec.ts -g "Master 3" --headed --debug
```

Common fixes needed:
- Ground positions: move to avoid wire crossings
- Fan-out tap points: must be ON an existing wire, not above/below it
- Viewport: add `#btn-tb-fit` click before placing components past y≈30
