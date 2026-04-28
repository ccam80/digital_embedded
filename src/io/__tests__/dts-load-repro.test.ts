import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DefaultSimulatorFacade } from '../../headless/default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';

const fixtures = [
  'fixtures/buckbjtandbuf.dts',
  'fixtures/buckbjt.dts',
  'fixtures/rlc-transient.dts',
  'fixtures/hwr-square.dts',
  'fixtures/npn-ce-harness.dts',
  'fixtures/pnp-cc-harness.dts',
  'fixtures/rlc-harness.dts',
  'fixtures/npn-ce-full-harness.dts',
];

describe('dts UI load + step (post-fix)', () => {
  for (const f of fixtures) {
    it(`step ${f}`, () => {
      const json = readFileSync(f, 'utf8');
      const registry = createDefaultRegistry();
      const facade = new DefaultSimulatorFacade(registry);
      const circuit = facade.deserialize(json);
      const coord = facade.compile(circuit);
      expect(() => facade.step(coord, { clockAdvance: false })).not.toThrow();
    });
  }
});
