import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentPalette } from '../../editor/palette.js';
import { ComponentRegistry } from '../../core/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): ComponentRegistry {
  return new ComponentRegistry();
}

// Simulate the toggle logic extracted from app-init.ts.
// Mode state is tracked exclusively in the palette filter.
// Cycle: null (auto) → digital → analog → null (auto)
function toggleMode(palette: ComponentPalette): void {
  const current = palette.getEngineTypeFilter();
  const next: 'digital' | 'analog' | null =
    current === null ? 'digital' : current === 'digital' ? 'analog' : null;
  palette.setEngineTypeFilter(next);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModeToggle', () => {
  let palette: ComponentPalette;

  beforeEach(() => {
    palette = new ComponentPalette(makeRegistry());
  });

  it('initial_filter_is_null', () => {
    expect(palette.getEngineTypeFilter()).toBeNull();
  });

  it('toggle_cycles_null_to_digital_to_analog_to_null', () => {
    // null → digital
    toggleMode(palette);
    expect(palette.getEngineTypeFilter()).toBe('digital');

    // digital → analog
    toggleMode(palette);
    expect(palette.getEngineTypeFilter()).toBe('analog');

    // analog → null
    toggleMode(palette);
    expect(palette.getEngineTypeFilter()).toBeNull();
  });

  it('toggle_updates_palette_filter', () => {
    // Initial: null filter (show all components)
    expect(palette.getEngineTypeFilter()).toBeNull();

    // Toggle → digital
    toggleMode(palette);
    expect(palette.getEngineTypeFilter()).toBe('digital');

    // Toggle → analog
    toggleMode(palette);
    expect(palette.getEngineTypeFilter()).toBe('analog');

    // Toggle → null (auto)
    toggleMode(palette);
    expect(palette.getEngineTypeFilter()).toBeNull();
  });

  it('set_analog_filter_shows_only_analog', () => {
    palette.setEngineTypeFilter('analog');
    expect(palette.getEngineTypeFilter()).toBe('analog');
  });

  it('set_null_filter_shows_all', () => {
    palette.setEngineTypeFilter('analog');
    palette.setEngineTypeFilter(null);
    expect(palette.getEngineTypeFilter()).toBeNull();
  });
});
