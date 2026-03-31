/**
 * Pin-map discovery — places each component type on an empty canvas and dumps
 * its pin positions relative to the placement grid coordinate.
 *
 * Usage:
 *   npx playwright test e2e/pin-map-discovery.spec.ts --headed
 *
 * Output goes to circuits/debug/pin-maps.json — a lookup table of:
 *   { [typeId]: { [pinLabel]: { dx: number, dy: number } } }
 *
 * where dx/dy are grid offsets from the placement position.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from './fixtures/ui-circuit-builder';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, '../circuits/debug');

// Component types used in assembly tests
const TYPES_TO_MAP = [
  // Digital
  'In', 'Out', 'Clock', 'Const', 'And', 'Or', 'Not', 'NAnd', 'XOr',
  'Counter', 'Comparator', 'D_FF', 'JK_FF', 'T_FF', 'RS_FF', 'Mux',
  'Button', 'LED',
  // Analog
  'Resistor', 'Capacitor', 'Inductor', 'DcVoltageSource', 'AcVoltageSource',
  'Ground', 'Probe', 'Potentiometer', 'OpAmp',
  // Mixed / active
  'DAC', 'ADC', 'Timer555', 'VoltageComparator', 'SchmittInverting',
  'NpnBJT', 'SwitchSPST', 'SwitchSPDT', 'Relay',
  // Wiring
  'Splitter', 'Tunnel',
];

const PLACE_X = 15;
const PLACE_Y = 15;

test('discover pin maps for all assembly component types', async ({ page }) => {
  const builder = new UICircuitBuilder(page);
  const pinMaps: Record<string, Record<string, { dx: number; dy: number }>> = {};

  for (const typeId of TYPES_TO_MAP) {
    // Fresh page for each component to avoid overlap
    await builder.load();

    try {
      await builder.placeComponent(typeId, PLACE_X, PLACE_Y);
    } catch {
      console.log(`SKIP: ${typeId} — could not place from palette`);
      continue;
    }

    const info = await builder.getCircuitInfo();
    const el = info.elements[info.elements.length - 1];
    if (!el) {
      console.log(`SKIP: ${typeId} — no element after placement`);
      continue;
    }

    // Query pin positions via bridge (screen coords) and convert to grid
    const pins: Record<string, { dx: number; dy: number }> = {};
    for (const pin of el.pins) {
      // Convert pin screen coords to grid coords via the test bridge
      const gridPos = await page.evaluate(
        ([sx, sy]) => (window as any).__test.screenToWorld(sx, sy),
        [pin.screenX, pin.screenY] as [number, number],
      );
      pins[pin.label] = {
        dx: Math.round(gridPos.x - PLACE_X),
        dy: Math.round(gridPos.y - PLACE_Y),
      };
    }

    pinMaps[typeId] = pins;
    console.log(`${typeId}: ${JSON.stringify(pins)}`);
  }

  // Write results
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    resolve(OUT_DIR, 'pin-maps.json'),
    JSON.stringify(pinMaps, null, 2),
    'utf-8',
  );

  console.log(`\nPin maps written to circuits/debug/pin-maps.json`);
  console.log(`${Object.keys(pinMaps).length} component types mapped`);

  // Ensure we got some results
  expect(Object.keys(pinMaps).length).toBeGreaterThan(0);
});
