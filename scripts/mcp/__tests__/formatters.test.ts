/**
 * Unit tests for MCP formatter functions (domain-aware formatting).
 *
 * Verifies that formatters branch on domain field rather than
 * availableModels/isAnalogOnly heuristics, and that modelKey is shown
 * as the model tag.
 */

import { describe, it, expect } from 'vitest';
import { formatDiagnostics, formatNetlist, formatComponentDefinition } from '../formatters.js';
import type { Netlist, ComponentDescriptor, NetDescriptor, NetPin, PinDescriptor } from '../../../src/headless/netlist-types.js';
import type { Diagnostic } from '../../../src/compile/types.js';
import type { ComponentDefinition } from '../../../src/core/registry.js';

// ---------------------------------------------------------------------------
// formatDiagnostics
// ---------------------------------------------------------------------------

describe('formatDiagnostics', () => {
  it('returns "Diagnostics: none" when array is empty', () => {
    expect(formatDiagnostics([])).toBe('Diagnostics: none');
  });

  it('shows severity, code, and message', () => {
    const diags: Diagnostic[] = [
      { severity: 'error', code: 'floating-node', message: 'Node 3 is floating' },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain('ERROR floating-node: Node 3 is floating');
  });

  it('shows explanation when present', () => {
    const diags: Diagnostic[] = [
      {
        severity: 'warning',
        code: 'unconnected-input',
        message: 'Pin A is unconnected',
        explanation: 'An unconnected input defaults to logic 0.',
      },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain('An unconnected input defaults to logic 0.');
  });

  it('shows suggestions when present', () => {
    const diags: Diagnostic[] = [
      {
        severity: 'error',
        code: 'no-ground',
        message: 'No ground node',
        suggestions: [
          { text: 'Add a GND component', automatable: false },
          { text: 'Connect one node to ground', automatable: false },
        ],
      },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain('-> Add a GND component');
    expect(result).toContain('-> Connect one node to ground');
  });

  it('does not emit "-> Pins:" for any diagnostic', () => {
    const diags: Diagnostic[] = [
      { severity: 'error', code: 'width-mismatch', message: 'Width mismatch' },
    ];
    const result = formatDiagnostics(diags);
    expect(result).not.toContain('-> Pins:');
  });

  it('omits explanation and suggestions lines when absent', () => {
    const diags: Diagnostic[] = [
      { severity: 'info', code: 'dc-op-converged', message: 'DC op converged' },
    ];
    const result = formatDiagnostics(diags);
    const lines = result.split('\n');
    // Only header + one data line
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatNetlist
// ---------------------------------------------------------------------------

describe('formatNetlist', () => {
  function makeAnalogPin(componentLabel: string, pinLabel: string): NetPin {
    return { componentIndex: 0, componentType: 'Resistor', componentLabel, pinLabel, domain: 'analog' };
  }

  function makeDigitalPin(componentLabel: string, pinLabel: string): NetPin {
    return { componentIndex: 0, componentType: 'And', componentLabel, pinLabel, domain: 'digital' };
  }

  function makeAnalogPinDescriptor(label: string): PinDescriptor {
    return { label, domain: 'analog', netId: 1, connectedTo: [] };
  }

  function makeDigitalPinDescriptor(label: string, bitWidth: number, direction: 'INPUT' | 'OUTPUT'): PinDescriptor {
    return { label, domain: 'digital', bitWidth, direction, netId: 2, connectedTo: [] };
  }

  it('shows [modelKey] tag for components', () => {
    const netlist: Netlist = {
      components: [
        {
          index: 0,
          typeId: 'Resistor',
          label: 'R1',
          instanceId: 'r1',
          pins: [makeAnalogPinDescriptor('A'), makeAnalogPinDescriptor('B')],
          properties: {},
          modelKey: 'spice-l1',
        } as ComponentDescriptor,
      ],
      nets: [],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('[spice-l1]');
    expect(result).not.toContain('[analog]');
    expect(result).not.toContain('[mixed]');
    expect(result).not.toContain('[digital]');
  });

  it('shows [terminal] for analog pins in component pin summary', () => {
    const netlist: Netlist = {
      components: [
        {
          index: 0,
          typeId: 'Resistor',
          label: 'R1',
          instanceId: 'r1',
          pins: [makeAnalogPinDescriptor('A'), makeAnalogPinDescriptor('B')],
          properties: {},
          modelKey: 'spice-l1',
        } as ComponentDescriptor,
      ],
      nets: [],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('A[terminal]');
    expect(result).toContain('B[terminal]');
  });

  it('shows [N-bit, DIRECTION] for digital pins in component pin summary', () => {
    const netlist: Netlist = {
      components: [
        {
          index: 0,
          typeId: 'And',
          label: 'gate',
          instanceId: 'g1',
          pins: [
            makeDigitalPinDescriptor('A', 1, 'INPUT'),
            makeDigitalPinDescriptor('B', 1, 'INPUT'),
            makeDigitalPinDescriptor('out', 1, 'OUTPUT'),
          ],
          properties: {},
          modelKey: 'digital',
        } as ComponentDescriptor,
      ],
      nets: [],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('A[1-bit, INPUT]');
    expect(result).toContain('B[1-bit, INPUT]');
    expect(result).toContain('out[1-bit, OUTPUT]');
  });

  it('shows [M pins] for analog nets (no bit-width)', () => {
    const netlist: Netlist = {
      components: [],
      nets: [
        {
          netId: 1,
          domain: 'analog',
          pins: [makeAnalogPin('R1', 'A'), makeAnalogPin('R2', 'B')],
        } as NetDescriptor,
      ],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('Net #1 [2 pins]');
    expect(result).not.toMatch(/Net #1 \[\d+-bit/);
  });

  it('shows [N-bit, M pins] for digital nets', () => {
    const netlist: Netlist = {
      components: [
        {
          index: 0,
          typeId: 'Register',
          label: 'reg',
          instanceId: 'reg1',
          pins: [makeDigitalPinDescriptor('out', 8, 'OUTPUT'), makeDigitalPinDescriptor('in', 8, 'INPUT')],
          properties: {},
          modelKey: 'behavioral',
        } as ComponentDescriptor,
      ],
      nets: [
        {
          netId: 2,
          domain: 'digital',
          bitWidth: 8,
          pins: [makeDigitalPin('reg', 'out'), makeDigitalPin('reg', 'in')],
        } as NetDescriptor,
      ],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('Net #2 [8-bit, 2 pins]');
  });

  it('shows [terminal] for analog net pins', () => {
    const netlist: Netlist = {
      components: [],
      nets: [
        {
          netId: 1,
          domain: 'analog',
          pins: [makeAnalogPin('R1', 'A')],
        } as NetDescriptor,
      ],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('R1:A [terminal]');
  });

  it('shows [N-bit, DIRECTION] for digital net pins', () => {
    const netlist: Netlist = {
      components: [
        {
          index: 0,
          typeId: 'And',
          label: 'gate',
          instanceId: 'g1',
          pins: [makeDigitalPinDescriptor('out', 1, 'OUTPUT')],
          properties: {},
          modelKey: 'digital',
        } as ComponentDescriptor,
      ],
      nets: [
        {
          netId: 2,
          domain: 'digital',
          bitWidth: 1,
          pins: [makeDigitalPin('gate', 'out')],
        } as NetDescriptor,
      ],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('gate:out [1-bit, OUTPUT]');
    expect(result).not.toContain('gate:out [digital]');
  });

  it('filters out nets with zero pins', () => {
    const netlist: Netlist = {
      components: [],
      nets: [
        { netId: 1, domain: 'digital', bitWidth: 1, pins: [] } as NetDescriptor,
        { netId: 2, domain: 'analog', pins: [makeAnalogPin('R1', 'A')] } as NetDescriptor,
      ],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('Nets (1)');
    expect(result).not.toContain('Net #1');
    expect(result).toContain('Net #2');
  });

  it('does not use availableModels or isAnalogOnly heuristics', () => {
    // The component has modelKey 'behavioral' — should show [behavioral], not [analog]/[mixed]
    const netlist: Netlist = {
      components: [
        {
          index: 0,
          typeId: 'DcVoltageSource',
          label: 'Vdc',
          instanceId: 'v1',
          pins: [makeAnalogPinDescriptor('P'), makeAnalogPinDescriptor('N')],
          properties: {},
          modelKey: 'behavioral',
        } as ComponentDescriptor,
      ],
      nets: [],
      diagnostics: [],
    };
    const result = formatNetlist(netlist);
    expect(result).toContain('[behavioral]');
    expect(result).not.toContain('[analog]');
    expect(result).not.toContain('[mixed]');
  });
});

// ---------------------------------------------------------------------------
// formatComponentDefinition
// ---------------------------------------------------------------------------

describe('formatComponentDefinition', () => {
  function makeMinimalDef(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
    return {
      name: 'TestComp',
      category: 'TEST',
      factory: () => { throw new Error('factory not needed'); },
      ...overrides,
    } as unknown as ComponentDefinition;
  }

  it('shows component name and category', () => {
    const result = formatComponentDefinition(makeMinimalDef());
    expect(result).toContain('Component: TestComp');
    expect(result).toContain('Category: TEST');
  });

  it('always shows [N-bit, DIRECTION] for pins regardless of model registry', () => {
    const def = makeMinimalDef({
      pinLayout: [
        { label: 'A', direction: 'INPUT', defaultBitWidth: 1 },
        { label: 'B', direction: 'INPUT', defaultBitWidth: 1 },
        { label: 'out', direction: 'OUTPUT', defaultBitWidth: 1 },
      ] as ComponentDefinition['pinLayout'],
      modelRegistry: {
        behavioral: {} as never,
        'spice-l1': {} as never,
      },
    });
    const result = formatComponentDefinition(def);
    expect(result).toContain('A [1-bit, INPUT]');
    expect(result).toContain('B [1-bit, INPUT]');
    expect(result).toContain('out [1-bit, OUTPUT]');
    expect(result).not.toContain('[terminal, INPUT]');
    expect(result).not.toContain('[terminal, OUTPUT]');
  });

  it('does not use defIsAnalogOnly heuristic', () => {
    // Analog-only component: has modelRegistry but no models.digital
    const def = makeMinimalDef({
      models: undefined,
      pinLayout: [
        { label: 'P', direction: 'INPUT', defaultBitWidth: 1 },
        { label: 'N', direction: 'OUTPUT', defaultBitWidth: 1 },
      ] as ComponentDefinition['pinLayout'],
      modelRegistry: { 'spice-l1': {} as never },
    });
    const result = formatComponentDefinition(def);
    // Must NOT show [terminal, ...] — that was the defIsAnalogOnly path
    expect(result).not.toContain('[terminal,');
    expect(result).toContain('P [1-bit, INPUT]');
    expect(result).toContain('N [1-bit, OUTPUT]');
  });

  it('lists models from modelRegistry', () => {
    const def = makeMinimalDef({
      modelRegistry: {
        behavioral: {} as never,
        'spice-l1': {} as never,
      },
    });
    const result = formatComponentDefinition(def);
    expect(result).toContain('Models:');
    expect(result).toContain('behavioral');
    expect(result).toContain('spice-l1');
  });

  it('omits Models line when modelRegistry is absent', () => {
    const result = formatComponentDefinition(makeMinimalDef({ modelRegistry: undefined }));
    expect(result).not.toContain('Models:');
  });
});
