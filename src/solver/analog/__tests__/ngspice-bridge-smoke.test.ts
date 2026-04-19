/**
 * Smoke test for the ngspice FFI bridge.
 * Requires NGSPICE_DLL_PATH env var pointing to instrumented spice.dll.
 */
import { describe, it } from 'vitest';
import { NgspiceBridge } from './harness/ngspice-bridge.js';
import { resolve } from 'path';

const DLL_PATH = process.env.NGSPICE_DLL_PATH
  ?? resolve(__dirname, '../../../../ref/ngspice/visualc-shared/x64/Release/bin/spice.dll');

describe('ngspice bridge smoke test', () => {
  it('loads DLL and runs voltage divider DC OP', async () => {
    console.log(`DLL path: ${DLL_PATH}`);

    const bridge = new NgspiceBridge(DLL_PATH);
    await bridge.init();
    console.log('Bridge initialized');

    bridge.loadNetlist(`* Voltage divider
V1 1 0 DC 10
R1 1 2 1k
R2 2 0 1k
.end`);
    console.log('Netlist loaded');

    bridge.runDcOp();
    console.log('DC OP complete');

    const session = bridge.getCaptureSession();
    console.log(`Captured ${session.steps.length} steps`);

    if (session.steps.length > 0) {
      const step = session.steps[0];
      console.log(`Step 0: ${step.iterations.length} iterations`);
      for (const iter of step.iterations) {
        const vStr = Array.from(iter.voltages).map(v => v.toExponential(4)).join(', ');
        console.log(`  iter ${iter.iteration}: noncon=${iter.noncon} converged=${iter.globalConverged}`);
        console.log(`    V: [${vStr}]`);
      }
    }

    bridge.dispose();
    console.log('Bridge disposed');
  });
});
