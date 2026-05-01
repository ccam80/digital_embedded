/**
 * Parity tests- mirror headless integration tests but run in a real browser
 * via the postMessage API.
 *
 * These catch the blind spot where the headless facade works fine but the
 * browser wiring (app-init, postMessage handler, DOM setup) is broken.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const circuitsDir = resolve(__dirname, '../../circuits');

test.describe('Parity: load and simulate via postMessage', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
  });

  test('AND gate- load .dig and run test vectors', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    const result = await harness.runTests('A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  test('Half adder- load .dig and run test vectors', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'half-adder.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    const result = await harness.runTests(
      'A B S Cout\n0 0 0 0\n0 1 1 0\n1 0 1 0\n1 1 0 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  test('AND gate- load via URL and run test vectors', async () => {
    await harness.loadDigUrl('/circuits/and-gate.dig');

    const result = await harness.runTests('A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  test('AND gate- failing test vector detected', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    // Deliberately wrong: expects 1 1 → 0, but AND gives 1
    const result = await harness.runTests('A B Y\n0 0 0\n1 1 0');
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
  });

  test('get-circuit round-trip- export produces dts-json-base64 format', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    await harness.postToSim({ type: 'sim-get-circuit' });
    const msg = await harness.waitForMessage<{
      type: 'sim-circuit-data';
      data: string;
      format: string;
    }>('sim-circuit-data');

    expect(msg.format).toBe('dts-json-base64');
    const decoded = Buffer.from(msg.data, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded) as { format: string; version: number };
    expect(parsed.format).toBe('dts');
    expect(parsed.version).toBe(1);
  });

  test('get-circuit round-trip- export then reimport preserves circuit', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    const b64 = await harness.getCircuit();
    expect(b64.length).toBeGreaterThan(0);

    await harness.postToSim({ type: 'sim-load-data', data: b64 });
    await harness.waitForMessage('sim-loaded');

    const result = await harness.runTests('A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1');
    expect(result.passed).toBe(4);
  });

  test('sim-get-circuit / sim-load-data- modelParamDeltas survive round-trip', async () => {
    // Build a minimal DTS circuit with a NpnBJT, a model entry, and a BF delta.
    // The DTS JSON is constructed inline so no file I/O is needed in the browser.
    const dtsWithDelta = JSON.stringify({
      format: 'dts',
      version: 1,
      models: {
        NpnBJT: {
          '2N2222': {
            kind: 'inline',
            // Full spice-l1 param set- use '_inf' sentinel for Infinity
            // (JSON.stringify nullifies Infinity; the DTS deserializer decodes
            // both '_inf' and null back to Infinity).
            params: {
              BF: 100, IS: 1e-14, NF: 1, BR: 1, NR: 1,
              ISE: 0, ISC: 0, NE: 1.5, NC: 2,
              VAF: '_inf', VAR: '_inf', IKF: '_inf', IKR: '_inf',
              RB: 0, RC: 0, RE: 0, CJE: 0, CJC: 0,
              VJE: 0.75, VJC: 0.75, MJE: 0.33, MJC: 0.33,
              TF: 0, TR: 0, EG: 1.11, XTB: 0, XTI: 3,
            },
          },
        },
      },
      circuit: {
        name: 'BF Delta Test',
        elements: [
          {
            type: 'NpnBJT',
            id: 'q1',
            position: { x: 0, y: 0 },
            rotation: 0,
            properties: { model: '2N2222' },
            modelParamDeltas: {
              model: '2N2222',
              params: { BF: 250 },
            },
          },
        ],
        wires: [],
      },
    });

    const b64 = Buffer.from(dtsWithDelta, 'utf-8').toString('base64');
    await harness.postToSim({ type: 'sim-load-data', data: b64 });
    await harness.waitForMessage('sim-loaded');

    // Export: should produce DTS JSON preserving the delta
    await harness.postToSim({ type: 'sim-get-circuit' });
    const msg = await harness.waitForMessage<{
      type: 'sim-circuit-data';
      data: string;
      format: string;
    }>('sim-circuit-data');

    expect(msg.format).toBe('dts-json-base64');
    const exported = JSON.parse(
      Buffer.from(msg.data, 'base64').toString('utf-8'),
    ) as {
      circuit: {
        elements: Array<{
          modelParamDeltas?: { model: string; params: Record<string, number> };
        }>;
      };
    };

    const elDelta = exported.circuit.elements[0]?.modelParamDeltas;
    expect(elDelta).toBeDefined();
    expect(elDelta?.model).toBe('2N2222');
    expect(elDelta?.params['BF']).toBe(250);
  });
});
