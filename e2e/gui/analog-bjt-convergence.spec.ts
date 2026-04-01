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
 *   TunnelDiode:     A@(pos),   K@(pos+4,0)
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
 *   TunnelDiode TD  (43,12) rot=90: A@(43,12)   K@(43,8)
 *   Capacitor C1    (52,11) rot=90: pos@(52,11) neg@(52,7)
 *   Resistor Rload  (58,11) rot=90: A@(58,11)   B@(58,7)
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
  await builder.setComponentProperty('Vac', 'amplitude', 4.983907855756475);
  await builder.setComponentProperty('Vac', 'frequency', 10000);
  await builder.setComponentProperty('Vac', 'waveform', 'square');

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

  // Tunnel "NDRV" at (39,10) rot=0 — NMOS gate drive
  await builder.placeLabeled('Tunnel', 39, 10, 'T_NDRV_M');
  await builder.setComponentProperty('T_NDRV_M', 'Net Name', 'NDRV');

  // --- Tunnel diode snubber ---
  // TunnelDiode TD at (43,12) rot=90: A@(43,12), K@(43,8)
  await builder.placeLabeled('TunnelDiode', 43, 12, 'TD', 90);

  // --- LC filter + load ---
  // Inductor L1 at (46,5) rot=0: A@(46,5), B@(50,5)
  await builder.placeLabeled('Inductor', 46, 5, 'L1');
  await builder.setComponentProperty('L1', 'inductance', 0.3);

  // Capacitor C1 at (52,11) rot=90: pos@(52,11), neg@(52,7)
  await builder.placeLabeled('Capacitor', 52, 11, 'C1', 90);
  await builder.setComponentProperty('C1', 'capacitance', 0.00001);

  // DEBUG PAUSE: All components up to C1 placed. Next: Rload at (58,11) rot=90.
  // Rload placement is failing (element count doesn't increase).
  // Check: Is (58,11) visible on canvas? Is another component blocking it?
  await builder.page.waitForTimeout(300_000);

  // Rload (50Ω) at (58,11) rot=90: A@(58,11), B@(58,7)
  await builder.placeLabeled('Resistor', 58, 11, 'Rload', 90);
  await builder.setComponentProperty('Rload', 'resistance', 50);

  // --- Probes (not in .dts — added for test assertions) ---
  await builder.placeLabeled('Probe', 22, 3, 'V_SUPPLY');
  await builder.placeLabeled('Probe', 45, 3, 'V_SWITCH');
  await builder.placeLabeled('Probe', 55, 3, 'V_OUT');

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
  await builder.drawWireExplicit('Vac', 'pos', 'Vdc', 'neg');
  // Vdc.neg@(9,15) → R2.B@(33,15)
  await builder.drawWireExplicit('Vdc', 'neg', 'R2', 'B');
  // R2.B@(33,15) → (58,15) → Rload.A@(58,11) — extends bus and connects load
  await builder.drawWireExplicit('R2', 'B', 'Rload', 'A', [[58, 15]]);
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
  await builder.drawWireExplicit('T_DRV_S', 'in', 'Vac', 'neg');

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
  // Rload.B@(58,7) → (58,5) → output node at (52,5)
  await builder.drawWireFromPinExplicit('Rload', 'B', 52, 5, [[58, 5]]);

  // --- Probe wiring (taps onto existing circuit wires) ---
  // V_SUPPLY taps supply rail at (22,5)
  await builder.drawWireFromPinExplicit('V_SUPPLY', 'in', 22, 5);
  // V_SWITCH taps switch node wire at (43,5) via (45,5)
  await builder.drawWireFromPinExplicit('V_SWITCH', 'in', 43, 5, [[45, 5]]);
  // V_OUT taps output wire at (55,5)
  await builder.drawWireFromPinExplicit('V_OUT', 'in', 55, 5);
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
    test.setTimeout(600_000); // 10 min for visual review
    // >>> REVIEW PAUSE: Circuit built from fixtures/buckbjt.dts reference.
    // Run with: npx playwright test analog-bjt-convergence --headed --project=chromium
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
    // Close the browser or press Ctrl+C when done reviewing.
    await builder.page.waitForTimeout(300_000);

    // Compile and step via toolbar
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // After compilation — check for errors before proceeding.

    // Add traces on probes via right-click context menu
    await builder.addTraceViaContextMenu('V_SUPPLY', 'in');
    await builder.addTraceViaContextMenu('V_SWITCH', 'in');
    await builder.addTraceViaContextMenu('V_OUT', 'in');

    // Step to 1ms for initial settling
    await builder.stepToTimeViaUI('1m');

    // Traces added and stepped to 1ms — assertions follow.

    // Read trace statistics from scope panel
    const stats = await builder.getTraceStats();
    expect(stats, 'Trace stats should be available after stepping').not.toBeNull();
    expect(stats!.length).toBeGreaterThanOrEqual(3);

    // Supply rail trace must show 10V (DC source, constant)
    const supplyTrace = stats!.find(s => s.label.includes('V_SUPPLY'));
    expect(supplyTrace, 'V_SUPPLY trace not found in scope panel').toBeDefined();
    expect(Math.abs(supplyTrace!.mean - 10.0) / 10.0,
      `V_SUPPLY mean = ${supplyTrace!.mean.toFixed(4)}V, expected 10V`,
    ).toBeLessThan(0.001);

    // All traces must be finite and bounded (no NR divergence)
    for (const trace of stats!) {
      expect(Number.isFinite(trace.min),
        `${trace.label} min is not finite: ${trace.min}`).toBe(true);
      expect(Number.isFinite(trace.max),
        `${trace.label} max is not finite: ${trace.max}`).toBe(true);
      expect(Math.abs(trace.max),
        `${trace.label} max out of range: ${trace.max}V`).toBeLessThanOrEqual(50);
    }
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

    // Add traces via context menu
    await builder.addTraceViaContextMenu('V_SUPPLY', 'in');
    await builder.addTraceViaContextMenu('V_OUT', 'in');

    // Step to 0.5ms and capture early trace stats
    await builder.stepToTimeViaUI('500u');
    const statsEarly = await builder.getTraceStats();
    expect(statsEarly).not.toBeNull();
    const outEarly = statsEarly!.find(s => s.label.includes('V_OUT'));
    expect(outEarly, 'V_OUT trace at 0.5ms').toBeDefined();
    expect(Number.isFinite(outEarly!.mean)).toBe(true);

    // Step to 5ms (50 square-wave half-cycles at 10kHz)
    await builder.stepToTimeViaUI('5m');
    const statsLate = await builder.getTraceStats();
    expect(statsLate).not.toBeNull();
    const outLate = statsLate!.find(s => s.label.includes('V_OUT'));
    expect(outLate, 'V_OUT trace at 5ms').toBeDefined();
    expect(Number.isFinite(outLate!.mean)).toBe(true);

    // Supply rail must remain at 10V throughout
    const supplyLate = statsLate!.find(s => s.label.includes('V_SUPPLY'));
    expect(supplyLate).toBeDefined();
    expect(Math.abs(supplyLate!.mean - 10.0) / 10.0,
      `V_SUPPLY = ${supplyLate!.mean.toFixed(4)}V, expected 10V`,
    ).toBeLessThan(0.001);

    // simTime must have advanced to at least 5ms
    const state = await builder.getAnalogState();
    expect(state).not.toBeNull();
    expect(state!.simTime).toBeGreaterThanOrEqual(0.005 - 1e-9);

    // Trace statistics must show the output voltage has evolved:
    // At 0.5ms the filter is still charging; by 5ms the switching
    // has produced a different voltage profile. Either the mean or
    // the peak-to-peak range must differ between the two snapshots.
    const evolved =
      outEarly!.mean !== outLate!.mean ||
      outEarly!.max !== outLate!.max ||
      outEarly!.min !== outLate!.min;
    expect(evolved,
      `V_OUT must evolve: early(${outEarly!.min.toFixed(4)}–${outEarly!.max.toFixed(4)}V) ` +
      `vs late(${outLate!.min.toFixed(4)}–${outLate!.max.toFixed(4)}V)`,
    ).toBe(true);
  });
});
