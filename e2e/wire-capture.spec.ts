/**
 * Wire capture workflow — places components, pauses for manual wiring,
 * then captures the wire layout and generates explicit wiring code.
 *
 * Usage:
 *   npx playwright test e2e/wire-capture.spec.ts --headed --debug
 *
 * Workflow:
 *   1. Test places all components and prints the connection list
 *   2. YOU draw wires manually in the browser
 *   3. Click "Resume" in Playwright Inspector
 *   4. Test captures wire data and outputs drawWireExplicit code to console
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder, type CircuitInfo } from './fixtures/ui-circuit-builder';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, 'circuits/debug');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WireSeg { x1: number; y1: number; x2: number; y2: number }
interface Pt { x: number; y: number }
interface PinInfo { label: string; pin: string; x: number; y: number }

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

/**
 * Build a flat list of all pin positions with their component label and pin name.
 */
function buildPinIndex(info: CircuitInfo): PinInfo[] {
  const pins: PinInfo[] = [];
  for (const el of info.elements) {
    for (const pin of el.pins) {
      pins.push({ label: el.label, pin: pin.label, x: 0, y: 0 }); // screen coords filled below
    }
  }
  return pins;
}

/**
 * Find the pin closest to a grid point, within tolerance.
 */
function findPin(gridPins: PinInfo[], pt: Pt, tol = 0.5): PinInfo | null {
  let best: PinInfo | null = null;
  let bestDist = Infinity;
  for (const p of gridPins) {
    const d = Math.abs(p.x - pt.x) + Math.abs(p.y - pt.y);
    if (d < bestDist && d <= tol) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Group wire segments into connected paths (nets).
 * Two segments are in the same net if they share an endpoint.
 */
function groupIntoNets(wires: WireSeg[]): WireSeg[][] {
  const parent = wires.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a: number, b: number) { parent[find(a)] = find(b); }

  const ptKey = (x: number, y: number) => `${Math.round(x * 2) / 2},${Math.round(y * 2) / 2}`;
  const endpointMap = new Map<string, number[]>();

  for (let i = 0; i < wires.length; i++) {
    const w = wires[i];
    for (const key of [ptKey(w.x1, w.y1), ptKey(w.x2, w.y2)]) {
      const existing = endpointMap.get(key);
      if (existing) {
        for (const j of existing) union(i, j);
        existing.push(i);
      } else {
        endpointMap.set(key, [i]);
      }
    }
  }

  const groups = new Map<number, WireSeg[]>();
  for (let i = 0; i < wires.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(wires[i]);
  }
  return [...groups.values()];
}

/**
 * For a net (group of connected wire segments), find all pin endpoints
 * and the intermediate waypoints needed to reproduce the path.
 */
function analyzeNet(
  segments: WireSeg[],
  gridPins: PinInfo[],
): { pins: PinInfo[]; waypoints: Pt[]; allPoints: Pt[] } {
  // Collect all unique endpoints
  const ptKey = (p: Pt) => `${Math.round(p.x * 2) / 2},${Math.round(p.y * 2) / 2}`;
  const seen = new Set<string>();
  const allPoints: Pt[] = [];

  for (const seg of segments) {
    const p1: Pt = { x: seg.x1, y: seg.y1 };
    const p2: Pt = { x: seg.x2, y: seg.y2 };
    for (const p of [p1, p2]) {
      const k = ptKey(p);
      if (!seen.has(k)) {
        seen.add(k);
        allPoints.push(p);
      }
    }
  }

  // Identify which points are pins vs waypoints
  const pinPoints: PinInfo[] = [];
  const waypoints: Pt[] = [];
  for (const pt of allPoints) {
    const pin = findPin(gridPins, pt);
    if (pin) {
      pinPoints.push(pin);
    } else {
      waypoints.push(pt);
    }
  }

  return { pins: pinPoints, waypoints, allPoints };
}

/**
 * Generate wiring code for a net.
 */
function generateWiringCode(net: { pins: PinInfo[]; waypoints: Pt[] }): string[] {
  const lines: string[] = [];
  if (net.pins.length < 2) {
    lines.push(`// WARNING: net has ${net.pins.length} pin(s), expected >= 2`);
    return lines;
  }

  // For 2-pin nets: simple drawWireExplicit
  if (net.pins.length === 2) {
    const [from, to] = net.pins;
    const wpStr = net.waypoints.length > 0
      ? `, [${net.waypoints.map(w => `[${Math.round(w.x)}, ${Math.round(w.y)}]`).join(', ')}]`
      : '';
    lines.push(
      `await builder.drawWireExplicit('${from.label}', '${from.pin}', '${to.label}', '${to.pin}'${wpStr});`,
    );
    return lines;
  }

  // For multi-pin nets (fan-out): first wire from pin[0] to pin[1],
  // then subsequent pins tap into existing wire
  const [first, ...rest] = net.pins;
  // Sort remaining pins by distance from first to get a sensible wiring order
  lines.push(`// Net: ${net.pins.map(p => `${p.label}.${p.pin}`).join(', ')}`);
  lines.push(
    `await builder.drawWireExplicit('${first.label}', '${first.pin}', '${rest[0].label}', '${rest[0].pin}');`,
  );
  for (let i = 1; i < rest.length; i++) {
    // For fan-out pins, start from the unconnected pin and route to existing wire
    lines.push(
      `// Fan-out: ${rest[i].label}.${rest[i].pin} taps into existing net`,
    );
    // Find nearest waypoint on existing wire to use as tap target
    if (net.waypoints.length > 0) {
      const nearest = net.waypoints[0]; // simplified
      lines.push(
        `await builder.drawWireFromPinExplicit('${rest[i].label}', '${rest[i].pin}', ${Math.round(nearest.x)}, ${Math.round(nearest.y)});`,
      );
    } else {
      lines.push(
        `await builder.drawWireFromPinExplicit('${rest[i].label}', '${rest[i].pin}', ${Math.round(first.x)}, ${Math.round(first.y)});`,
      );
    }
  }
  return lines;
}

// ===========================================================================
// MASTER 1: Digital Logic — component placement + wire capture
// ===========================================================================

test.describe('Wire capture', () => {

  test('Master 1: Digital — place, wire manually, capture', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // --- Place inputs (col 3) ---
    await builder.placeLabeled('In', 3, 4, 'A');
    await builder.placeLabeled('In', 3, 8, 'B');
    await builder.placeLabeled('Clock', 3, 27, 'CLK');
    await builder.placeLabeled('Const', 3, 32, 'EN');

    // --- Place gates (col 10) ---
    await builder.placeLabeled('And', 10, 4, 'G_AND');
    await builder.placeLabeled('Or', 10, 10, 'G_OR');
    await builder.placeLabeled('XOr', 10, 16, 'G_XOR');
    await builder.placeLabeled('Not', 10, 22, 'G_NOT');

    // --- Place sequential (col 10, lower) ---
    await builder.placeLabeled('D_FF', 10, 26, 'FF');
    await builder.placeLabeled('Counter', 10, 32, 'CNT');

    // --- Place outputs (col 20) ---
    await builder.placeLabeled('Out', 20, 5, 'AND_Y');
    await builder.placeLabeled('Out', 20, 11, 'OR_Y');
    await builder.placeLabeled('Out', 20, 17, 'XOR_Y');
    await builder.placeLabeled('Out', 20, 22, 'NOT_Y');
    await builder.placeLabeled('Out', 20, 26, 'Q');
    await builder.placeLabeled('Out', 20, 32, 'CNT_Y');

    // Print connection list for manual wiring
    console.log('\n========================================');
    console.log('DRAW THESE CONNECTIONS MANUALLY:');
    console.log('========================================');
    console.log('Net A:       A.out → G_AND.In_1, G_OR.In_1, G_XOR.In_1, G_NOT.in');
    console.log('Net B:       B.out → G_AND.In_2, G_OR.In_2, G_XOR.In_2');
    console.log('Net AND_out: G_AND.out → AND_Y.in, FF.D');
    console.log('Net OR_out:  G_OR.out → OR_Y.in');
    console.log('Net XOR_out: G_XOR.out → XOR_Y.in');
    console.log('Net NOT_out: G_NOT.out → NOT_Y.in');
    console.log('Net CLK:     CLK.out → FF.C, CNT.C');
    console.log('Net EN:      EN.out → CNT.en');
    console.log('Net Q:       FF.Q → Q.in');
    console.log('Net CNT_out: CNT.out → CNT_Y.in');
    console.log('========================================');
    console.log('Draw wires, then click Resume.\n');

    // Pause for manual wiring
    await page.pause();

    // --- Capture wire data ---
    console.log('\n======== CAPTURING WIRE DATA ========\n');

    // Get circuit info with pin positions
    const info = await builder.getCircuitInfo();

    // Get all pin positions in grid coords via bridge
    const gridPins: PinInfo[] = [];
    for (const el of info.elements) {
      for (const pin of el.pins) {
        const gridPos = await page.evaluate(
          ([sx, sy]) => (window as any).__test.screenToWorld(sx, sy),
          [pin.screenX, pin.screenY] as [number, number],
        );
        gridPins.push({
          label: el.label,
          pin: pin.label,
          x: Math.round(gridPos.x * 2) / 2, // round to half-grid
          y: Math.round(gridPos.y * 2) / 2,
        });
      }
    }

    // Get wire segments
    const obstacles = await page.evaluate(
      () => (window as any).__test.getRoutingObstacles(),
    ) as { wires: WireSeg[]; pins: Pt[] };

    console.log(`Found ${obstacles.wires.length} wire segments, ${gridPins.length} pins`);

    // Group wires into nets
    const nets = groupIntoNets(obstacles.wires);
    console.log(`Grouped into ${nets.length} nets\n`);

    // Analyze each net and generate code
    const allCode: string[] = [];
    allCode.push('// --- Generated wiring code ---');

    for (let i = 0; i < nets.length; i++) {
      const analysis = analyzeNet(nets[i], gridPins);
      const pinNames = analysis.pins.map(p => `${p.label}.${p.pin}`).join(', ');
      console.log(`Net ${i + 1}: ${pinNames}`);
      console.log(`  Segments: ${nets[i].length}, Pins: ${analysis.pins.length}, Waypoints: ${analysis.waypoints.length}`);

      if (analysis.waypoints.length > 0) {
        console.log(`  Waypoints: ${analysis.waypoints.map(w => `(${w.x},${w.y})`).join(' → ')}`);
      }

      const code = generateWiringCode(analysis);
      allCode.push('', ...code);
    }

    console.log('\n======== GENERATED CODE ========\n');
    console.log(allCode.join('\n'));

    // Write to file
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      resolve(OUT_DIR, 'master1-wiring-code.ts'),
      allCode.join('\n'),
      'utf-8',
    );
    console.log(`\nCode written to circuits/debug/master1-wiring-code.ts`);

    // Also export the circuit for reference
    const xml = await builder.exportCircuitDigXml();
    if (xml) {
      writeFileSync(resolve(OUT_DIR, 'master1-reference.dig'), xml, 'utf-8');
      console.log('Circuit exported to circuits/debug/master1-reference.dig');
    }

    expect(obstacles.wires.length).toBeGreaterThan(0);
  });

  test('Master 2: Analog — place, wire manually, capture', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // --- Section A: Power + switch + voltage divider (y=3) ---
    await builder.placeLabeled('DcVoltageSource', 3, 3, 'Vs');    // neg(3,3) pos(7,3)
    await builder.placeLabeled('In', 3, 7, 'CTRL');
    await builder.placeLabeled('SwitchSPST', 12, 3, 'SW');        // in(12,3) out(16,3) ctrl(14,4)
    await builder.placeLabeled('Resistor', 20, 3, 'R1');           // A(20,3) B(24,3)
    await builder.placeLabeled('Resistor', 28, 3, 'R2');           // A(28,3) B(32,3)
    await builder.placeComponent('Ground', 3, 8);                   // for Vs.neg
    await builder.placeComponent('Ground', 32, 8);                  // for R2.B
    await builder.placeLabeled('Probe', 26, 1, 'P_DIV');

    // --- Section B: RC lowpass (y=11) ---
    await builder.placeLabeled('Resistor', 20, 11, 'R3');
    await builder.placeLabeled('Capacitor', 28, 11, 'C1');
    await builder.placeComponent('Ground', 32, 15);
    await builder.placeLabeled('Probe', 26, 9, 'P_RC');

    // --- Section C: OpAmp buffer (y=19) ---
    await builder.placeLabeled('OpAmp', 28, 19, 'AMP');           // in-(28,18) in+(28,20) out(32,19)
    await builder.placeLabeled('Probe', 36, 19, 'P_AMP');

    // --- Section D: BJT CE amplifier (y=25) ---
    await builder.placeLabeled('Resistor', 20, 25, 'Rb');
    await builder.placeLabeled('NpnBJT', 28, 25, 'Q1');           // B(28,25) C(32,24) E(32,26)
    await builder.placeLabeled('Resistor', 36, 24, 'Rc');          // A(36,24) B(40,24)
    await builder.placeLabeled('DcVoltageSource', 36, 30, 'Vcc'); // neg(36,30) pos(40,30)
    await builder.placeComponent('Ground', 32, 30);                 // for BJT.E
    await builder.placeComponent('Ground', 36, 34);                 // for Vcc.neg
    await builder.placeLabeled('Probe', 44, 24, 'P_CE');

    console.log('\n========================================');
    console.log('DRAW THESE CONNECTIONS MANUALLY:');
    console.log('========================================');
    console.log('Net Vs_pos:  Vs.pos → SW.in');
    console.log('Net CTRL:    CTRL.out → SW.ctrl');
    console.log('Net SW_out:  SW.out → R1.A');
    console.log('Net DIV:     R1.B → R2.A, R3.A, P_DIV.in');
    console.log('Net R2_gnd:  R2.B → GND(32,8)');
    console.log('Net Vs_gnd:  Vs.neg → GND(3,8)');
    console.log('Net RC:      R3.B → C1.pos, P_RC.in, AMP.in+');
    console.log('Net C1_gnd:  C1.neg → GND(32,20)');
    console.log('Net AMP_out: AMP.out → AMP.in-(feedback), P_AMP.in, Rb.A');
    console.log('Net BJT_B:   Rb.B → Q1.B');
    console.log('Net BJT_C:   Q1.C → Rc.A, P_CE.in');
    console.log('Net Vcc_pos: Vcc.pos → Rc.B');   // Vcc.pos(40,30) → Rc.B(40,24) same col
    console.log('Net BJT_E:   Q1.E → GND(32,30)');
    console.log('Net Vcc_gnd: Vcc.neg → GND(36,34)');
    console.log('========================================');
    console.log('Draw wires, then click Resume.\n');

    await page.pause();

    // --- Capture ---
    const info = await builder.getCircuitInfo();
    const gridPins: PinInfo[] = [];
    for (const el of info.elements) {
      for (const pin of el.pins) {
        const gridPos = await page.evaluate(
          ([sx, sy]) => (window as any).__test.screenToWorld(sx, sy),
          [pin.screenX, pin.screenY] as [number, number],
        );
        gridPins.push({
          label: el.label, pin: pin.label,
          x: Math.round(gridPos.x * 2) / 2, y: Math.round(gridPos.y * 2) / 2,
        });
      }
    }

    const obstacles = await page.evaluate(
      () => (window as any).__test.getRoutingObstacles(),
    ) as { wires: WireSeg[]; pins: Pt[] };

    console.log(`Found ${obstacles.wires.length} wire segments`);
    const nets = groupIntoNets(obstacles.wires);
    const allCode: string[] = ['// --- Master 2: Generated wiring code ---'];
    for (let i = 0; i < nets.length; i++) {
      const analysis = analyzeNet(nets[i], gridPins);
      const pinNames = analysis.pins.map(p => `${p.label}.${p.pin}`).join(', ');
      console.log(`Net ${i + 1}: ${pinNames}`);
      if (analysis.waypoints.length > 0)
        console.log(`  Waypoints: ${analysis.waypoints.map(w => `(${w.x},${w.y})`).join(' → ')}`);
      allCode.push('', ...generateWiringCode(analysis));
    }

    console.log('\n======== GENERATED CODE ========\n');
    console.log(allCode.join('\n'));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, 'master2-wiring-code.ts'), allCode.join('\n'), 'utf-8');
    const xml = await builder.exportCircuitDigXml();
    if (xml) writeFileSync(resolve(OUT_DIR, 'master2-reference.dig'), xml, 'utf-8');

    expect(obstacles.wires.length).toBeGreaterThan(0);
  });

  test('Master 3: Mixed — place, wire manually, capture', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // --- DAC inputs ---
    await builder.placeLabeled('Const', 3, 8, 'D0');
    await builder.setComponentProperty('D0', 'value', 0);
    await builder.placeLabeled('Const', 3, 11, 'D1');
    await builder.setComponentProperty('D1', 'value', 1);
    await builder.placeLabeled('Const', 3, 14, 'D2');
    await builder.setComponentProperty('D2', 'value', 0);
    await builder.placeLabeled('Const', 3, 17, 'D3');
    await builder.setComponentProperty('D3', 'value', 1);

    // --- DAC ---
    await builder.placeLabeled('DAC', 15, 15, 'DAC1');
    await builder.setComponentProperty('DAC1', 'Resolution (bits)', 4);

    // --- DAC power ---
    await builder.placeLabeled('DcVoltageSource', 8, 3, 'Vref');
    await builder.placeComponent('Ground', 8, 8);
    await builder.placeComponent('Ground', 17, 22);

    // --- RC filter ---
    await builder.placeLabeled('Resistor', 25, 15, 'R1');
    await builder.placeLabeled('Capacitor', 33, 15, 'C1');
    await builder.placeComponent('Ground', 37, 16);
    await builder.placeLabeled('Probe', 31, 13, 'P_DAC');

    // --- Voltage Comparator ---
    await builder.placeLabeled('VoltageComparator', 33, 19, 'CMP');
    await builder.setComponentProperty('CMP', 'Output type', 'push-pull');
    await builder.placeLabeled('DcVoltageSource', 25, 21, 'Vref2');
    await builder.setComponentProperty('Vref2', 'Voltage (V)', 2.5);
    await builder.placeComponent('Ground', 25, 24);

    // --- Digital output chain ---
    await builder.placeLabeled('And', 38, 18, 'GA');
    await builder.placeLabeled('Const', 38, 20, 'C_EN');
    await builder.placeLabeled('Clock', 34, 24, 'CLK');
    await builder.placeLabeled('Counter', 44, 18, 'CNT');
    await builder.placeLabeled('Out', 48, 18, 'Q');
    await builder.setComponentProperty('Q', 'Bits', 4);

    console.log('\n========================================');
    console.log('DRAW THESE CONNECTIONS MANUALLY:');
    console.log('========================================');
    console.log('Net D0:      D0.out → DAC1.D0');
    console.log('Net D1:      D1.out → DAC1.D1');
    console.log('Net D2:      D2.out → DAC1.D2');
    console.log('Net D3:      D3.out → DAC1.D3');
    console.log('Net VREF:    Vref.pos → DAC1.VREF');
    console.log('Net Vref_gnd: Vref.neg → GND(8,8)');
    console.log('Net DAC_gnd: DAC1.GND → GND(17,22)');
    console.log('Net DAC_out: DAC1.OUT → R1.A');
    console.log('Net RC:      R1.B → C1.pos, P_DAC.in, CMP.in+');
    console.log('Net C1_gnd:  C1.neg → GND(37,20)');
    console.log('Net CMP_ref: Vref2.pos → CMP.in-');
    console.log('Net Vref2_gnd: Vref2.neg → GND(25,24)');
    console.log('Net CMP_out: CMP.out → GA.In_1');
    console.log('Net AND_en:  C_EN.out → GA.In_2');
    console.log('Net AND_out: GA.out → CNT.en');
    console.log('Net CLK:     CLK.out → CNT.C');
    console.log('Net CNT_out: CNT.out → Q.in');
    console.log('========================================');
    console.log('Draw wires, then click Resume.\n');

    await page.pause();

    // --- Capture ---
    const info = await builder.getCircuitInfo();
    const gridPins: PinInfo[] = [];
    for (const el of info.elements) {
      for (const pin of el.pins) {
        const gridPos = await page.evaluate(
          ([sx, sy]) => (window as any).__test.screenToWorld(sx, sy),
          [pin.screenX, pin.screenY] as [number, number],
        );
        gridPins.push({
          label: el.label, pin: pin.label,
          x: Math.round(gridPos.x * 2) / 2, y: Math.round(gridPos.y * 2) / 2,
        });
      }
    }

    const obstacles = await page.evaluate(
      () => (window as any).__test.getRoutingObstacles(),
    ) as { wires: WireSeg[]; pins: Pt[] };

    console.log(`Found ${obstacles.wires.length} wire segments`);
    const nets = groupIntoNets(obstacles.wires);
    const allCode: string[] = ['// --- Master 3: Generated wiring code ---'];
    for (let i = 0; i < nets.length; i++) {
      const analysis = analyzeNet(nets[i], gridPins);
      const pinNames = analysis.pins.map(p => `${p.label}.${p.pin}`).join(', ');
      console.log(`Net ${i + 1}: ${pinNames}`);
      if (analysis.waypoints.length > 0)
        console.log(`  Waypoints: ${analysis.waypoints.map(w => `(${w.x},${w.y})`).join(' → ')}`);
      allCode.push('', ...generateWiringCode(analysis));
    }

    console.log('\n======== GENERATED CODE ========\n');
    console.log(allCode.join('\n'));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, 'master3-wiring-code.ts'), allCode.join('\n'), 'utf-8');
    const xml = await builder.exportCircuitDigXml();
    if (xml) writeFileSync(resolve(OUT_DIR, 'master3-reference.dig'), xml, 'utf-8');

    expect(obstacles.wires.length).toBeGreaterThan(0);
  });
});
