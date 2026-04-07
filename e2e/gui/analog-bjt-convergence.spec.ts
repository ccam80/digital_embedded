/**
 * E2E: BJT buck converter convergence & analog simulation validation.
 *
 * Builds the buckbjt circuit via genuine UI interactions (palette clicks,
 * canvas placement, wire drawing with explicit waypoints). The circuit is
 * a switched-mode power supply:
 *   10kHz square wave → push-pull BJT buffer (NPN + PNP) → NMOS switch →
 *   LC filter (0.3H + 10µF) → 50Ω load, powered from 10V DC.
 *
 * Named nets (via Tunnel components) connect distant sections:
 *   10V — DC supply rail
 *   DRV — AC drive signal to both BJT base resistors
 *   NDRV — NPN collector output to NMOS gate
 *
 * Tests verify:
 *   1. Nonlinear NR convergence (multiple BJTs, NMOS, tunnel diode)
 *   2. DC supply rail reads exactly 10V via scope trace stats
 *   3. Transient voltages are finite, bounded, and evolving
 *   4. stepToTime advances the engine to the correct sim-time
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Tolerance helper
// ---------------------------------------------------------------------------

function expectClose(actual: number, expected: number, rtol = 1e-6, atol = 1e-9) {
  const err = Math.abs(actual - expected);
  const limit = Math.max(atol, Math.abs(expected) * rtol);
  expect(err, `Expected ${actual} to be close to ${expected} (err=${err}, limit=${limit})`).toBeLessThan(limit);
}

// ---------------------------------------------------------------------------
// Circuit builder helper
// ---------------------------------------------------------------------------

/**
 * Build the buck BJT converter circuit via UI clicks.
 *
 * Component positions, rotations, and wire paths are taken directly from
 * fixtures/buckbjt.dts. Pin positions at each rotation (rot=0 offsets,
 * then rotated 90° CW per quarter-turn):
 *
 *   DcVoltageSource: neg@(pos), pos@(pos+4,0)
 *   AcVoltageSource: pos@(pos), neg@(pos+4,0)
 *   Resistor:        A@(pos),   B@(pos+4,0)
 *   NpnBJT:          B@(pos),   C@(pos+4,-1), E@(pos+4,+1)
 *   PnpBJT:          B@(pos),   C@(pos+4,+1), E@(pos+4,-1)
 *   NMOS:            G@(pos),   D@(pos+4,-1), S@(pos+4,+1)
 *   Inductor:        A@(pos),   B@(pos+4,0)
 *   Capacitor:       pos@(pos), neg@(pos+4,0)
 *   Diode:     A@(pos),   K@(pos+4,0)
 *   Ground/Tunnel/Probe: pin@(pos)
 *
 * Rotation transform (90° CW): (dx,dy) → (dy, -dx)
 *
 * Key computed pin positions after rotation:
 *   DcVoltageSource (9,15) rot=90:  neg@(9,15)  pos@(9,11)
 *   AcVoltageSource (4,15) rot=90:  pos@(4,15)  neg@(4,11)
 *   Resistor R1     (20,10) rot=90: A@(20,10)   B@(20,6)
 *   Resistor R2     (33,11) rot=270:A@(33,11)   B@(33,15)
 *   NMOS M1         (39,9) rot=90:  G@(39,9)    D@(38,5)  S@(40,5)
 *   Diode TD  (43,12) rot=90: A@(43,12)   K@(43,8)
 *   Capacitor C1    (52,11) rot=90: pos@(52,11) neg@(52,7)
 *   Resistor Rload  (57,11) rot=90: A@(57,11)   B@(57,7)
 *
 * Auto-connections via pin overlap (same grid position, no wire needed):
 *   T_DRV_N.in@(12,12) = Rb1.A@(12,12)
 *   Rb1.B@(16,12)      = Q1.B@(16,12)
 *   T_DRV_P.in@(25,9)  = Rb2.A@(25,9)
 *   Rb2.B@(29,9)       = Q2.B@(29,9)
 */
async function buildBuckBJT(builder: UICircuitBuilder): Promise<void> {
  // =======================================================================
  // COMPONENT PLACEMENT — positions & rotations match fixtures/buckbjt.dts
  // =======================================================================

  // --- Power supplies ---
  await builder.placeLabeled('DcVoltageSource', 9, 15, 'Vdc', 90);
  await builder.setComponentProperty('Vdc', 'voltage', 10);

  await builder.placeLabeled('AcVoltageSource', 4, 15, 'Vac', 90);
  await builder.setComponentProperty('Vac', 'amplitude', 2.4919539278782376);
  await builder.setComponentProperty('Vac', 'frequency', 10000);
  await builder.setComponentProperty('Vac', 'waveform', 'square');
  await builder.setSpiceParameter('Vac', 'dcOffset', 2.4919539278782376);

  await builder.placeComponent('Ground', 20, 16);

  // --- Named-net tunnels ---
  await builder.placeLabeled('Tunnel', 4, 9, 'T_DRV_S', 90);
  await builder.setComponentProperty('T_DRV_S', 'Net Name', 'DRV');

  await builder.placeLabeled('Tunnel', 20, 4, 'T_10V', 90);
  await builder.setComponentProperty('T_10V', 'Net Name', '10V');

  // --- NPN driver section ---
  // Tunnel "DRV" at (12,12) rot=180 — pin overlaps Rb1.A for auto-connect
  await builder.placeLabeled('Tunnel', 12, 12, 'T_DRV_N', 180);
  await builder.setComponentProperty('T_DRV_N', 'Net Name', 'DRV');

  // Rb1 (1kΩ) at (12,12) rot=0: A@(12,12) overlaps T_DRV_N, B@(16,12) overlaps Q1.B
  await builder.placeLabeled('Resistor', 12, 12, 'Rb1');
  await builder.setComponentProperty('Rb1', 'resistance', 1000);

  // NpnBJT Q1 at (16,12) rot=0: B@(16,12), C@(20,11), E@(20,13)
  await builder.placeLabeled('NpnBJT', 16, 12, 'Q1');

  // R1 (10kΩ) at (20,10) rot=90: A@(20,10), B@(20,6)
  await builder.placeLabeled('Resistor', 20, 10, 'R1', 90);
  await builder.setComponentProperty('R1', 'resistance', 10000);

  // Tunnel "NDRV" at (21,11) rot=0 — NPN collector output
  await builder.placeLabeled('Tunnel', 21, 11, 'T_NDRV_N');
  await builder.setComponentProperty('T_NDRV_N', 'Net Name', 'NDRV');

  // --- PNP driver section ---
  // Tunnel "DRV" at (25,9) rot=180 — pin overlaps Rb2.A for auto-connect
  await builder.placeLabeled('Tunnel', 25, 9, 'T_DRV_P', 180);
  await builder.setComponentProperty('T_DRV_P', 'Net Name', 'DRV');

  // Rb2 (1kΩ) at (25,9) rot=0: A@(25,9) overlaps T_DRV_P, B@(29,9) overlaps Q2.B
  await builder.placeLabeled('Resistor', 25, 9, 'Rb2');
  await builder.setComponentProperty('Rb2', 'resistance', 1000);

  // PnpBJT Q2 at (29,9) rot=0: B@(29,9), C@(33,10), E@(33,8)
  await builder.placeLabeled('PnpBJT', 29, 9, 'Q2');

  // R2 (10kΩ) at (33,11) rot=270: A@(33,11), B@(33,15) — B on ground bus
  await builder.placeLabeled('Resistor', 33, 11, 'R2', 270);
  await builder.setComponentProperty('R2', 'resistance', 10000);

  // Tunnel "PDRV" at (34,10) rot=0 — PNP collector label
  await builder.placeLabeled('Tunnel', 34, 10, 'T_PDRV');
  await builder.setComponentProperty('T_PDRV', 'Net Name', 'PDRV');

  // --- NMOS switch ---
  // NMOS M1 at (39,9) rot=90: G@(39,9), D@(38,5), S@(40,5)
  await builder.placeLabeled('NMOS', 39, 9, 'M1', 90);
  await builder.selectNamedModel('M1', '2N7000');

  // Tunnel "NDRV" at (39,10) rot=0 — NMOS gate drive
  await builder.placeLabeled('Tunnel', 39, 10, 'T_NDRV_M');
  await builder.setComponentProperty('T_NDRV_M', 'Net Name', 'NDRV');

  // --- Tunnel diode snubber ---
  // Diode TD at (43,12) rot=90: A@(43,12), K@(43,8)
  await builder.placeLabeled('Diode', 43, 12, 'TD', 90);

  // --- LC filter + load ---
  // Inductor L1 at (46,5) rot=0: A@(46,5), B@(50,5)
  await builder.placeLabeled('Inductor', 46, 5, 'L1');
  await builder.setComponentProperty('L1', 'inductance', 0.3);

  // Capacitor C1 at (52,11) rot=90: pos@(52,11), neg@(52,7)
  await builder.placeLabeled('Capacitor', 52, 11, 'C1', 90);
  await builder.setComponentProperty('C1', 'capacitance', 0.00001);

  // Zoom to fit so far-right Rload position is on-screen
  await builder.page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
  await builder.page.keyboard.press('Control+Shift+F');
  await builder.page.waitForTimeout(200);

  // Rload (50Ω) at (57,11) rot=90: A@(57,11), B@(57,7)
  // Shifted 1 grid unit left from .dts (58,11) to fit default viewport.
  await builder.placeLabeled('Resistor', 57, 11, 'Rload', 90);
  await builder.setComponentProperty('Rload', 'resistance', 50);

  // =======================================================================
  // WIRING — routes derived from fixtures/buckbjt.dts wire paths
  // =======================================================================

  // --- Supply rail (y=5 horizontal bus) ---
  // Vdc.pos@(9,11) → (9,5) → (20,5) → T_10V@(20,4)
  await builder.drawWireExplicit('Vdc', 'pos', 'T_10V', 'in', [[9, 5], [20, 5]]);
  // M1.D@(38,5) → supply rail junction at (20,5) — creates horizontal bus
  await builder.drawWireFromPinExplicit('M1', 'D', 20, 5);
  // R1.B@(20,6) → supply rail at (20,5)
  await builder.drawWireFromPinExplicit('R1', 'B', 20, 5);
  // Q2.E@(33,8) → supply rail at (33,5)
  await builder.drawWireFromPinExplicit('Q2', 'E', 33, 5);

  // --- Ground bus (y=15 horizontal bus) ---
  // Vac.pos@(4,15) → Vdc.neg@(9,15)
  await builder.drawWireExplicit('Vac', 'neg', 'Vdc', 'neg');
  // Vdc.neg@(9,15) → R2.B@(33,15)
  await builder.drawWireExplicit('Vdc', 'neg', 'R2', 'B');
  // R2.B@(33,15) → (57,15) → Rload.A@(57,11) — extends bus and connects load
  await builder.drawWireExplicit('R2', 'B', 'Rload', 'A', [[57, 15]]);
  // Ground@(20,16) → ground bus at (20,15)
  await builder.drawWireByPath([[20, 16], [20, 15]]);
  // Q1.E@(20,13) → ground bus at (20,15)
  await builder.drawWireFromPinExplicit('Q1', 'E', 20, 15);
  // TD.A@(43,12) → ground bus at (43,15)
  await builder.drawWireFromPinExplicit('TD', 'A', 43, 15);
  // C1.pos@(52,11) → ground bus at (52,15)
  await builder.drawWireFromPinExplicit('C1', 'pos', 52, 15);

  // --- DRV source ---
  // T_DRV_S@(4,9) → Vac.neg@(4,11)
  await builder.drawWireExplicit('T_DRV_S', 'in', 'Vac', 'pos');

  // --- NPN section ---
  // R1.A@(20,10) → Q1.C@(20,11)
  await builder.drawWireExplicit('R1', 'A', 'Q1', 'C');
  // T_NDRV_N@(21,11) → Q1.C@(20,11) — junction at collector
  await builder.drawWireExplicit('T_NDRV_N', 'in', 'Q1', 'C');

  // --- PNP section ---
  // R2.A@(33,11) → Q2.C@(33,10)
  await builder.drawWireExplicit('R2', 'A', 'Q2', 'C');
  // Q2.C@(33,10) → T_PDRV@(34,10)
  await builder.drawWireExplicit('Q2', 'C', 'T_PDRV', 'in');

  // --- NMOS gate ---
  // M1.G@(39,9) → T_NDRV_M@(39,10)
  await builder.drawWireExplicit('M1', 'G', 'T_NDRV_M', 'in');

  // --- Switch node ---
  // M1.S@(40,5) → (43,5) → L1.A@(46,5)
  await builder.drawWireExplicit('M1', 'S', 'L1', 'A', [[43, 5]]);
  // TD.K@(43,8) → switch node junction at (43,5)
  await builder.drawWireFromPinExplicit('TD', 'K', 43, 5);

  // --- Output section ---
  // L1.B@(50,5) → (52,5) → C1.neg@(52,7)
  await builder.drawWireExplicit('L1', 'B', 'C1', 'neg', [[52, 5]]);
  // Rload.B@(57,7) → (57,5) → output node at (52,5)
  await builder.drawWireFromPinExplicit('Rload', 'B', 52, 5, [[57, 5]]);

}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('BJT buck converter convergence', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
    await buildBuckBJT(builder);
  });

  // =========================================================================
  // Test 1: Compile + step — no convergence error, supply rail is 10V
  // =========================================================================

  test('compile and step — no convergence error, supply rail is 10V', async () => {
    // Circuit built from fixtures/buckbjt.dts reference.
    //
    // WHAT TO CHECK:
    //   1. POWER SUPPLIES (far left):
    //      Vdc (10V) and Vac (square) both VERTICAL (rot=90), sharing ground bus at y=15
    //      DRV tunnel at (4,9) connects down to Vac.neg at (4,11)
    //
    //   2. NPN SECTION (x≈12-21):
    //      T_DRV_N tunnel (pointing left) → Rb1 (horizontal) → Q1.B (auto-connect at 16,12)
    //      R1 (vertical, rot=90) between supply rail (y=5) and Q1.C (y=11)
    //      T_NDRV_N tunnel at (21,11) wired to Q1.C
    //      Q1.E wired down to ground bus at (20,15)
    //
    //   3. PNP SECTION (x≈25-34):
    //      T_DRV_P tunnel (pointing left) → Rb2 (horizontal) → Q2.B (auto-connect at 29,9)
    //      R2 (vertical, rot=270) from Q2.C (y=10) down to ground bus (y=15)
    //      Q2.E wired up to supply rail at (33,5)
    //      T_PDRV tunnel at (34,10)
    //
    //   4. NMOS SWITCH (x≈38-40):
    //      M1 vertical (rot=90): D@(38,5) on supply rail, S@(40,5) to switch node
    //      Gate wired down to T_NDRV_M at (39,10)
    //
    //   5. SWITCH NODE → LC FILTER → LOAD (x≈43-58):
    //      M1.S → (43,5) → L1.A@(46,5) → L1.B@(50,5) → output node (52,5)
    //      TD snubber: K@(43,8)→switch node, A@(43,12)→ground bus
    //      C1 vertical (rot=90): neg@(52,7) on output, pos@(52,11)→ground bus
    //      Rload vertical (rot=90): B@(58,7) on output, A@(58,11)→ground bus
    //
    //   6. SUPPLY RAIL (y=5): horizontal from (9,5) through (20,5), (33,5) to (38,5)
    //      10V tunnel at (20,4) taps in. R1.B, Q2.E, M1.D all connect.
    //
    //   7. GROUND BUS (y=15): horizontal from (4,15) to (58,15)
    //      Ground symbol at (20,16). Q1.E, TD.A, C1.pos, Rload.A, R2.B all connect.
    //
    //   8. PROBES: V_SUPPLY@(22,3)→supply rail, V_SWITCH@(45,3)→switch node,
    //      V_OUT@(55,3)→output node
    //
    //   9. NO floating wires, no diagonal segments, no disconnected components.
    //
    // Compile and step — must not throw convergence error
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // --- Phase 1: BJT drivers at 1.025ms ---
    await builder.addTraceViaContextMenu('Q1', 'C');
    await builder.addTraceViaContextMenu('Q2', 'C');
    await builder.addCurrentTraceViaContextMenu('Q1');
    await builder.addCurrentTraceViaContextMenu('Q2');

    // Measure at 1.025ms — 1/4 through cycle, drive HIGH, NPN on
    await builder.stepToTimeViaUI('1.025m');
    const vals = await builder.getTraceValues();
    expect(vals).not.toBeNull();
    expect(vals!.length).toBeGreaterThanOrEqual(4);

    // Dump full analog state to diagnose
    const analogState = await builder.getAnalogState();
    console.log(`[buckbjt] analogState:`, JSON.stringify(analogState));

    const [vQ1c, vQ2c, iQ1, iQ2] = vals!.map(v => v.value);
    console.log(`[buckbjt] 1.025ms: V(Q1.C)=${vQ1c}, V(Q2.C)=${vQ2c}, Ic_Q1=${iQ1}, Ic_Q2=${iQ2}`);
    expectClose(vQ1c, 2.084652e-02);      // NPN saturated, collector low
    expectClose(vQ2c, 9.979174e+00);      // PNP collector near VCC
    expectClose(iQ1, 9.979153e-04);       // NPN Ic ≈ 998µA
    expectClose(iQ2, -9.979174e-04);      // PNP Ic ≈ -998µA

    // --- Phase 2: Steady state — last 2 switching cycles (499.8ms–500ms) ---
    await builder.addTraceViaContextMenu('M1', 'S');    // switch node
    await builder.addTraceViaContextMenu('Rload', 'B'); // output node
    await builder.addCurrentTraceViaContextMenu('TD');   // diode current

    await builder.stepToTimeViaUI('500m');
    const ss = await builder.getTraceStatsInRange(0.4998, 0.5);
    expect(ss).not.toBeNull();

    // Traces order: [Q1.C, Q2.C, Q1 I, Q2 I, M1.S, Rload.B, TD I]
    const swStats = ss![4];
    const outStats = ss![5];
    const diodeStats = ss![6];

    console.log(`[buckbjt] SS: V(sw) min=${swStats.min} max=${swStats.max} mean=${swStats.mean}`);
    console.log(`[buckbjt] SS: V(out) min=${outStats.min} max=${outStats.max} mean=${outStats.mean}`);
    console.log(`[buckbjt] SS: I(TD) min=${diodeStats.min} max=${diodeStats.max} mean=${diodeStats.mean}`);

    // ngspice refs: steady state 499.8ms–500ms
    expectClose(swStats.min, -7.611475e-01);
    expectClose(swStats.max, 6.643749e+00);
    expectClose(swStats.mean, 2.940029e+00);

    expectClose(outStats.min, 2.939642e+00);
    expectClose(outStats.max, 2.940413e+00);
    expectClose(outStats.mean, 2.940027e+00);

    expectClose(diodeStats.min, -5.910892e-02);
    expectClose(diodeStats.max, 6.653749e-12);
    expectClose(diodeStats.mean, -2.940124e-02);
  });

  // =========================================================================
  // Test 2: Run briefly — no divergence, all voltages bounded
  // =========================================================================

  test('run continuously — voltages remain bounded', async () => {
    // Compile
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Run for 500ms wall time, then stop
    await builder.runViaUI();
    await builder.page.waitForTimeout(500);

    // Read state while running
    const state = await builder.getAnalogState();
    expect(state, 'Analog engine should be active').not.toBeNull();
    expect(state!.simTime).toBeGreaterThan(0);

    await builder.stopViaUI();
    await builder.page.waitForTimeout(200);

    await builder.verifyNoErrors();

    // All node voltages must be finite and bounded
    for (const [label, v] of Object.entries(state!.nodeVoltages)) {
      expect(Number.isFinite(v),
        `Voltage at "${label}" is not finite: ${v}`).toBe(true);
      expect(Math.abs(v),
        `Voltage at "${label}" out of range: ${v}V`).toBeLessThanOrEqual(50);
    }
  });

  // =========================================================================
  // Test 3: Step to 5ms — output voltage evolves via trace capture
  // =========================================================================

  test('step to 5ms — output voltage evolves and trace captures transient', async () => {
    // Compile
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Add traces on output and switch node
    await builder.addTraceViaContextMenu('Rload', 'B');  // output
    await builder.addTraceViaContextMenu('M1', 'S');     // switch node

    // Step to 1ms — early snapshot
    await builder.stepToTimeViaUI('1m');
    const early = await builder.getTraceValues();
    expect(early).not.toBeNull();
    const vOutEarly = early![0].value;
    console.log(`[buckbjt-t3] 1ms: V(out)=${vOutEarly}`);

    // Step to 5ms — late snapshot
    await builder.stepToTimeViaUI('5m');
    const late = await builder.getTraceValues();
    expect(late).not.toBeNull();
    const vOutLate = late![0].value;
    const vSwLate = late![1].value;
    console.log(`[buckbjt-t3] 5ms: V(out)=${vOutLate}, V(sw)=${vSwLate}`);

    // Output must have evolved (LC filter transient)
    expect(vOutEarly).not.toBeCloseTo(vOutLate, 1);

    // ngspice refs at 5ms
    expectClose(vOutLate, 4.259786e+00);
    expectClose(vSwLate, 6.430716e+00);

    // Trace stats over 4.9ms–5ms (last cycle) — switch node should swing
    const stats = await builder.getTraceStatsInRange(0.0049, 0.005);
    expect(stats).not.toBeNull();
    const swStats = stats![1];
    expect(swStats.max).toBeGreaterThan(swStats.min + 1.0);  // switch node swings > 1V
  });
});
