/**
 * Tests for pin-electrical.ts — PinElectricalSpec resolution cascade.
 */

import { describe, it, expect } from 'vitest';
import { resolvePinElectrical } from '../pin-electrical.js';
import { LOGIC_FAMILY_PRESETS } from '../logic-family.js';
import type { PinElectricalSpec } from '../pin-electrical.js';

const cmos3v3 = LOGIC_FAMILY_PRESETS['cmos-3v3'];

describe('Resolve', () => {
  it('family_defaults_used_when_no_overrides', () => {
    const resolved = resolvePinElectrical(cmos3v3);
    expect(resolved.rOut).toBe(cmos3v3.rOut);
    expect(resolved.cOut).toBe(cmos3v3.cOut);
    expect(resolved.rIn).toBe(cmos3v3.rIn);
    expect(resolved.cIn).toBe(cmos3v3.cIn);
    expect(resolved.vOH).toBe(cmos3v3.vOH);
    expect(resolved.vOL).toBe(cmos3v3.vOL);
    expect(resolved.vIH).toBe(cmos3v3.vIH);
    expect(resolved.vIL).toBe(cmos3v3.vIL);
    expect(resolved.rHiZ).toBe(cmos3v3.rHiZ);
  });

  it('component_override_takes_priority', () => {
    const componentOverride: PinElectricalSpec = { vOH: 2.8 };
    const resolved = resolvePinElectrical(cmos3v3, undefined, componentOverride);
    expect(resolved.vOH).toBe(2.8);
    // Other fields come from family
    expect(resolved.vOL).toBe(cmos3v3.vOL);
    expect(resolved.rOut).toBe(cmos3v3.rOut);
  });

  it('pin_override_beats_component', () => {
    const componentOverride: PinElectricalSpec = { rOut: 50 };
    const pinOverride: PinElectricalSpec = { rOut: 25 };
    const resolved = resolvePinElectrical(cmos3v3, pinOverride, componentOverride);
    expect(resolved.rOut).toBe(25);
  });

  it('partial_override_preserves_other_fields', () => {
    const pinOverride: PinElectricalSpec = { rOut: 100 };
    const resolved = resolvePinElectrical(cmos3v3, pinOverride);
    // Only rOut overridden
    expect(resolved.rOut).toBe(100);
    // Everything else from family
    expect(resolved.cOut).toBe(cmos3v3.cOut);
    expect(resolved.rIn).toBe(cmos3v3.rIn);
    expect(resolved.cIn).toBe(cmos3v3.cIn);
    expect(resolved.vOH).toBe(cmos3v3.vOH);
    expect(resolved.vOL).toBe(cmos3v3.vOL);
    expect(resolved.vIH).toBe(cmos3v3.vIH);
    expect(resolved.vIL).toBe(cmos3v3.vIL);
    expect(resolved.rHiZ).toBe(cmos3v3.rHiZ);
  });

  it('all_fields_required_in_result', () => {
    // Use TTL preset (vOL=0.35 > 0) so all fields are strictly positive finite numbers.
    const ttl = LOGIC_FAMILY_PRESETS['ttl'];
    const resolved = resolvePinElectrical(ttl);
    for (const [, value] of Object.entries(resolved)) {
      expect(typeof value).toBe('number');
      expect(isFinite(value as number)).toBe(true);
      expect(value as number).toBeGreaterThan(0);
    }
  });
});
