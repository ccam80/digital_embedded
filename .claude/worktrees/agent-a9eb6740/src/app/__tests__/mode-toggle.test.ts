import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentPalette } from '../../editor/palette.js';
import { ComponentRegistry } from '../../core/registry.js';
import { Circuit, defaultCircuitMetadata } from '../../core/circuit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCircuit(): Circuit {
  const c = new Circuit();
  c.metadata = defaultCircuitMetadata();
  return c;
}

function makeRegistry(): ComponentRegistry {
  return new ComponentRegistry();
}

// Simulate the toggle logic extracted from app-init.ts:
// On toggle: cycle auto → digital → analog → auto
function toggleMode(circuit: Circuit, palette: ComponentPalette): void {
  const current = circuit.metadata.engineType;
  const next = current === 'auto' ? 'digital' : current === 'digital' ? 'analog' : 'auto';
  circuit.metadata = { ...circuit.metadata, engineType: next };
  palette.setEngineTypeFilter(next === 'analog' ? 'analog' : next === 'digital' ? 'digital' : 'auto');
}

// Simulate load-time setup: read engineType from loaded circuit and set palette filter
function applyEngineTypeFromCircuit(circuit: Circuit, palette: ComponentPalette): void {
  const engineType = circuit.metadata.engineType;
  palette.setEngineTypeFilter(engineType === 'analog' ? 'analog' : engineType === 'auto' ? 'auto' : null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModeToggle', () => {
  let circuit: Circuit;
  let palette: ComponentPalette;

  beforeEach(() => {
    circuit = makeCircuit();
    palette = new ComponentPalette(makeRegistry());
  });

  it('toggle_sets_metadata_engine_type', () => {
    // Initial state is auto
    expect(circuit.metadata.engineType).toBe('auto');

    // Toggle auto → digital
    toggleMode(circuit, palette);
    expect(circuit.metadata.engineType).toBe('digital');

    // Toggle digital → analog
    toggleMode(circuit, palette);
    expect(circuit.metadata.engineType).toBe('analog');

    // Toggle analog → auto
    toggleMode(circuit, palette);
    expect(circuit.metadata.engineType).toBe('auto');
  });

  it('toggle_updates_palette_filter', () => {
    // Initial: auto mode → filter is null (show all components)
    expect(palette.getEngineTypeFilter()).toBeNull();

    // Toggle auto → digital
    toggleMode(circuit, palette);
    expect(palette.getEngineTypeFilter()).toBe('digital');

    // Toggle digital → analog
    toggleMode(circuit, palette);
    expect(palette.getEngineTypeFilter()).toBe('analog');

    // Toggle analog → auto
    toggleMode(circuit, palette);
    expect(palette.getEngineTypeFilter()).toBeNull();
  });

  it('load_analog_circuit_sets_palette_filter', () => {
    // Simulate loading a circuit that has engineType: "analog"
    circuit.metadata = { ...circuit.metadata, engineType: 'analog' };

    // Apply filter as done at load time
    applyEngineTypeFromCircuit(circuit, palette);

    expect(palette.getEngineTypeFilter()).toBe('analog');
  });

  it('load_digital_circuit_keeps_null_filter', () => {
    // Simulate loading a circuit that has engineType: "digital"
    circuit.metadata = { ...circuit.metadata, engineType: 'digital' };

    applyEngineTypeFromCircuit(circuit, palette);

    expect(palette.getEngineTypeFilter()).toBeNull();
  });
});
