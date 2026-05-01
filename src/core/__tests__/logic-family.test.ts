/**
 * Tests for logic-family.ts- LogicFamilyConfig presets and utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  LOGIC_FAMILY_PRESETS,
  defaultLogicFamily,
  getLogicFamilyPreset,
} from '../logic-family.js';

describe('Presets', () => {
  it('cmos_3v3_values_correct', () => {
    const preset = LOGIC_FAMILY_PRESETS['cmos-3v3'];
    expect(preset.vdd).toBe(3.3);
    expect(preset.vOH).toBe(3.3);
    expect(preset.vOL).toBe(0.0);
    expect(preset.vIH).toBe(2.0);
    expect(preset.vIL).toBe(0.8);
    expect(preset.rOut).toBe(50);
    expect(preset.rIn).toBe(1e7);
  });

  it('ttl_values_correct', () => {
    const preset = LOGIC_FAMILY_PRESETS['ttl'];
    expect(preset.vOH).toBe(3.4);
    expect(preset.vOL).toBe(0.35);
    expect(preset.rIn).toBe(4e3);
  });

  it('all_presets_have_positive_impedances', () => {
    for (const [, preset] of Object.entries(LOGIC_FAMILY_PRESETS)) {
      expect(preset.rOut).toBeGreaterThan(0);
      expect(preset.rIn).toBeGreaterThan(0);
      expect(preset.rHiZ).toBeGreaterThan(0);
      expect(preset.cIn).toBeGreaterThan(0);
      expect(preset.cOut).toBeGreaterThan(0);
    }
  });

  it('all_presets_thresholds_ordered', () => {
    for (const [, preset] of Object.entries(LOGIC_FAMILY_PRESETS)) {
      expect(preset.vOL).toBeLessThan(preset.vIL);
      expect(preset.vIL).toBeLessThan(preset.vIH);
      expect(preset.vIH).toBeLessThan(preset.vOH);
    }
  });
});

describe('Default', () => {
  it('default_returns_cmos_3v3', () => {
    const family = defaultLogicFamily();
    expect(family.vdd).toBe(3.3);
    expect(family.name).toBe('CMOS 3.3V');
  });
});

describe('getLogicFamilyPreset', () => {
  it('returns_preset_for_known_key', () => {
    const preset = getLogicFamilyPreset('cmos-5v');
    expect(preset).toBeDefined();
    expect(preset!.vdd).toBe(5.0);
  });

  it('returns_undefined_for_unknown_key', () => {
    const preset = getLogicFamilyPreset('does-not-exist');
    expect(preset).toBeUndefined();
  });
});
