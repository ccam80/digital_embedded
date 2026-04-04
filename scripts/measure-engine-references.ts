/**
 * measure-engine-references.ts
 *
 * Loads each analog test circuit as .dig XML through the headless facade,
 * compiles, steps to steady state, and prints node voltages. Compare these
 * against e2e/fixtures/spice-reference-values.json to determine per-circuit
 * tolerance for E2E assertions.
 *
 * Usage: npx tsx scripts/measure-engine-references.ts
 */
import { DefaultSimulatorFacade } from '../src/headless/default-facade.js';
import { createDefaultRegistry } from '../src/components/register-all.js';

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Circuit XML definitions — matching exactly what the E2E tests build
// ---------------------------------------------------------------------------

interface CircuitDef {
  name: string;
  xml: string;
  steps: number;
}

function analogXml(elements: string, wires: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes>
    <entry><string>engineType</string><string>analog</string></entry>
  </attributes>
  <visualElements>
${elements}
  </visualElements>
  <wires>
${wires}
  </wires>
</circuit>`;
}

function el(name: string, x: number, y: number, attrs: Record<string, string | number> = {}): string {
  const entries = Object.entries(attrs)
    .map(([k, v]) => {
      const tag = typeof v === 'number'
        ? (Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`)
        : `<string>${v}</string>`;
      return `        <entry><string>${k}</string>${tag}</entry>`;
    })
    .join('\n');
  return `    <visualElement>
      <elementName>${name}</elementName>
      <elementAttributes>
${entries}
      </elementAttributes>
      <pos x="${x}" y="${y}"/>
    </visualElement>`;
}

function wire(x1: number, y1: number, x2: number, y2: number): string {
  return `    <wire><p1 x="${x1}" y="${y1}"/><p2 x="${x2}" y="${y2}"/></wire>`;
}

const circuits: CircuitDef[] = [
  // A2: Voltage Divider — 5V, R1=1k, R2=1k
  {
    name: 'a2_voltage_divider',
    xml: analogXml(
      [
        el('DcVoltageSource', 140, 200, { Label: 'Vs', voltage: 5 }),
        el('AnalogResistor', 300, 200, { Label: 'R1', resistance: 1000 }),
        el('AnalogResistor', 460, 200, { Label: 'R2', resistance: 1000 }),
        el('Ground', 220, 300),
        el('Ground', 540, 300),
      ].join('\n'),
      [
        wire(100, 200, 300, 200),  // Vs:pos → R1:A
        wire(380, 200, 460, 200),  // R1:B → R2:A
        wire(540, 200, 540, 300),  // R2:B → G2
        wire(220, 200, 220, 300),  // Vs:neg → G1
      ].join('\n'),
    ),
    steps: 100,
  },
  // A7: Zener Regulator — Vs=10V, R=1k, Zener (reverse-biased)
  {
    name: 'a7_zener_regulator',
    xml: analogXml(
      [
        el('DcVoltageSource', 140, 200, { Label: 'Vs', voltage: 10 }),
        el('AnalogResistor', 300, 200, { Label: 'R1', resistance: 1000 }),
        el('AnalogZener', 460, 200, { Label: 'Z1' }),
        el('Ground', 220, 300),
        el('Ground', 540, 300),
      ].join('\n'),
      [
        wire(100, 200, 300, 200),  // Vs:pos → R1:A
        wire(380, 200, 460, 200),  // R1:B → Z1:K
        wire(540, 200, 540, 300),  // Z1:A → G2
        wire(220, 200, 220, 300),  // Vs:neg → G1
      ].join('\n'),
    ),
    steps: 300,
  },
  // A8: BJT CE — Vcc=12V, Vin=1V, Rc=4.7k, Rb=100k, Re=1k
  {
    name: 'a8_bjt_ce',
    xml: analogXml(
      [
        el('DcVoltageSource', 140, 100, { Label: 'Vcc', voltage: 12 }),
        el('DcVoltageSource', 140, 300, { Label: 'Vin', voltage: 1 }),
        el('AnalogResistor', 300, 100, { Label: 'Rc', resistance: 4700 }),
        el('AnalogResistor', 300, 300, { Label: 'Rb', resistance: 100000 }),
        el('NpnBJT', 460, 200, { Label: 'Q1' }),
        el('AnalogResistor', 460, 340, { Label: 'Re', resistance: 1000 }),
        el('Ground', 220, 160),   // Vcc:neg
        el('Ground', 220, 360),   // Vin:neg
        el('Ground', 540, 420),   // Re:B
      ].join('\n'),
      [
        wire(100, 100, 300, 100),  // Vcc:pos → Rc:A
        wire(380, 100, 460, 100),  // Rc:B → ...
        wire(460, 100, 460, 200),  // ... → Q1:C (assume C at top)
        wire(100, 300, 300, 300),  // Vin:pos → Rb:A
        wire(380, 300, 420, 300),  // Rb:B → ...
        wire(420, 300, 420, 200),  // ... → Q1:B (assume B at left)
        wire(460, 280, 460, 340),  // Q1:E → Re:A
        wire(540, 340, 540, 420),  // Re:B → G3
        wire(220, 100, 220, 160),  // Vcc:neg → G1
        wire(220, 300, 220, 360),  // Vin:neg → G2
      ].join('\n'),
    ),
    steps: 300,
  },
  // A9: BJT Differential Pair — balanced
  {
    name: 'a9_bjt_diffpair',
    xml: analogXml(
      [
        el('DcVoltageSource', 140, 100, { Label: 'Vcc', voltage: 12 }),
        el('DcVoltageSource', 140, 300, { Label: 'V1', voltage: 1 }),
        el('DcVoltageSource', 140, 500, { Label: 'V2', voltage: 1 }),
        el('AnalogResistor', 340, 100, { Label: 'Rc1', resistance: 4700 }),
        el('AnalogResistor', 540, 100, { Label: 'Rc2', resistance: 4700 }),
        el('NpnBJT', 340, 260, { Label: 'Q1' }),
        el('NpnBJT', 540, 260, { Label: 'Q2' }),
        el('AnalogResistor', 440, 400, { Label: 'Re', resistance: 10000 }),
        el('Ground', 220, 160),
        el('Ground', 220, 360),
        el('Ground', 220, 560),
        el('Ground', 440, 480),
      ].join('\n'),
      [
        wire(100, 100, 340, 100),  // Vcc:pos → Rc1:A
        wire(100, 100, 540, 100),  // Vcc:pos → Rc2:A (fan-out)
        wire(420, 100, 340, 200),  // Rc1:B → Q1:C
        wire(620, 100, 540, 200),  // Rc2:B → Q2:C
        wire(100, 300, 300, 260),  // V1:pos → Q1:B
        wire(100, 500, 500, 260),  // V2:pos → Q2:B
        wire(340, 340, 440, 400),  // Q1:E → Re:A
        wire(540, 340, 440, 400),  // Q2:E → Re:A (shared tail)
        wire(520, 400, 440, 480),  // Re:B → G4
        wire(220, 100, 220, 160),
        wire(220, 300, 220, 360),
        wire(220, 500, 220, 560),
      ].join('\n'),
    ),
    steps: 300,
  },
  // A12: MOSFET Common-Source
  {
    name: 'a12_mosfet_cs',
    xml: analogXml(
      [
        el('DcVoltageSource', 140, 100, { Label: 'Vdd', voltage: 12 }),
        el('DcVoltageSource', 140, 300, { Label: 'Vg', voltage: 3 }),
        el('AnalogResistor', 300, 100, { Label: 'Rd', resistance: 4700 }),
        el('AnalogResistor', 300, 300, { Label: 'Rg', resistance: 100000 }),
        el('NMOS', 460, 200, { Label: 'M1' }),
        el('AnalogResistor', 460, 340, { Label: 'Rs', resistance: 1000 }),
        el('Ground', 220, 160),
        el('Ground', 220, 360),
        el('Ground', 540, 420),
      ].join('\n'),
      [
        wire(100, 100, 300, 100),
        wire(380, 100, 460, 100),
        wire(460, 100, 460, 200),
        wire(100, 300, 300, 300),
        wire(380, 300, 420, 300),
        wire(420, 300, 420, 200),
        wire(460, 280, 460, 340),
        wire(540, 340, 540, 420),
        wire(220, 100, 220, 160),
        wire(220, 300, 220, 360),
      ].join('\n'),
    ),
    steps: 300,
  },
  // A15: JFET Amplifier
  {
    name: 'a15_jfet_amp',
    xml: analogXml(
      [
        el('DcVoltageSource', 140, 100, { Label: 'Vdd', voltage: 15 }),
        el('DcVoltageSource', 140, 300, { Label: 'Vg', voltage: 0 }),
        el('AnalogResistor', 300, 100, { Label: 'Rd', resistance: 2200 }),
        el('AnalogResistor', 300, 300, { Label: 'Rg', resistance: 1000000 }),
        el('NJFET', 460, 200, { Label: 'M1' }),
        el('AnalogResistor', 460, 340, { Label: 'Rs', resistance: 680 }),
        el('Ground', 220, 160),
        el('Ground', 220, 360),
        el('Ground', 540, 420),
      ].join('\n'),
      [
        wire(100, 100, 300, 100),
        wire(380, 100, 460, 100),
        wire(460, 100, 460, 200),
        wire(100, 300, 300, 300),
        wire(380, 300, 420, 300),
        wire(420, 300, 420, 200),
        wire(460, 280, 460, 340),
        wire(540, 340, 540, 420),
        wire(220, 100, 220, 160),
        wire(220, 300, 220, 360),
      ].join('\n'),
    ),
    steps: 300,
  },
];

// SPICE reference values
const spiceRef: Record<string, Record<string, number>> = {
  a2_voltage_divider: { v_mid: 2.5 },
  a7_zener_regulator: { v_regulated: 5.140892 },
  a8_bjt_ce: { v_collector: 11.04672, v_base: 0.8159996, v_emitter: 0.2046661 },
  a9_bjt_diffpair: { v_col1: 11.89609, v_col2: 11.89609 },
  a12_mosfet_cs: { v_drain: 4.456636, v_source: 1.604971 },
  a15_jfet_amp: { v_drain: 11.78713, v_source: 0.9930688 },
};

async function main() {
  const facade = new DefaultSimulatorFacade(registry);

  for (const def of circuits) {
    try {
      const circuit = facade.loadDigXml(def.xml);
      const engine = facade.compile(circuit);

      // Step to steady state
      for (let i = 0; i < def.steps; i++) {
        facade.step(engine);
      }

      // Read all labeled signals
      const signals = facade.readAllSignals(engine);

      console.log(`\n${def.name}:`);
      for (const [label, value] of Object.entries(signals)) {
        console.log(`  ${label} = ${(value as number).toFixed(6)}`);
      }
    } catch (err) {
      console.log(`\n${def.name}: ERROR — ${(err as Error).message}`);
    }
  }
}

main().catch(console.error);
