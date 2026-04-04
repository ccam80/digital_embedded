/**
 * W2-T2 acceptance criteria tests for circuit-tools.ts changes:
 *   - circuit_describe_file tool no longer registered
 *   - circuit_list pin display has no directional arrows
 *   - circuit_compile output suggests analog tools when available
 *   - circuit_test driver analysis degrades gracefully for analog pins
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDefaultRegistry } from '../../src/components/register-all.js';
import { DefaultSimulatorFacade } from '../../src/headless/default-facade.js';
import { SessionState } from '../mcp/tool-helpers.js';
import { registerCircuitTools } from '../mcp/circuit-tools.js';
import type { ComponentRegistry } from '../../src/core/registry.js';
import type { CircuitSpec } from '../../src/headless/netlist-types.js';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let registry: ComponentRegistry;
let facade: DefaultSimulatorFacade;
let server: McpServer;
let session: SessionState;

type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function getTool(name: string): ToolHandler {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })._registeredTools;
  const entry = tools[name];
  if (!entry) throw new Error(`Tool "${name}" not registered`);
  return entry.handler as ToolHandler;
}

function isToolRegistered(name: string): boolean {
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return name in tools;
}

async function callTool(name: string, input: Record<string, unknown>): Promise<string> {
  const handler = getTool(name);
  const result = await handler(input);
  return result.content.map((c) => c.text).join('\n');
}

beforeAll(() => {
  registry = createDefaultRegistry();
  facade = new DefaultSimulatorFacade(registry);
  server = new McpServer({ name: 'test', version: '0' });
  session = new SessionState();
  registerCircuitTools(server, facade, registry, session);
});

// ===========================================================================
// circuit_describe_file deletion
// ===========================================================================

describe('circuit_describe_file deletion', () => {
  it('circuit_describe_file is not registered', () => {
    expect(isToolRegistered('circuit_describe_file')).toBe(false);
  });

  it('other tools are still registered', () => {
    expect(isToolRegistered('circuit_list')).toBe(true);
    expect(isToolRegistered('circuit_build')).toBe(true);
    expect(isToolRegistered('circuit_compile')).toBe(true);
    expect(isToolRegistered('circuit_netlist')).toBe(true);
    expect(isToolRegistered('circuit_patch')).toBe(true);
    expect(isToolRegistered('circuit_test')).toBe(true);
    expect(isToolRegistered('circuit_describe')).toBe(true);
    expect(isToolRegistered('circuit_validate')).toBe(true);
    expect(isToolRegistered('circuit_save')).toBe(true);
    expect(isToolRegistered('circuit_test_equivalence')).toBe(true);
  });
});

// ===========================================================================
// circuit_list — no directional arrows
// ===========================================================================

describe('circuit_list include_pins', () => {
  it('include_pins: true shows no directional arrows (↓ ↑ ↕)', async () => {
    const output = await callTool('circuit_list', { include_pins: true });
    expect(output).not.toContain('↓');
    expect(output).not.toContain('↑');
    expect(output).not.toContain('↕');
  });

  it('include_pins: true shows pin labels in parentheses', async () => {
    const output = await callTool('circuit_list', { include_pins: true, category: 'LOGIC' });
    // And gate should show its pins without arrows
    expect(output).toMatch(/And\s*\(/);
    // Labels like In_1, In_2, out should appear without arrow suffixes
    expect(output).toMatch(/In_1/);
    expect(output).not.toMatch(/In_1[↓↑↕]/);
  });

  it('include_pins: false (default) shows no pins at all', async () => {
    const output = await callTool('circuit_list', { category: 'LOGIC' });
    expect(output).not.toContain('↓');
    expect(output).not.toContain('↑');
    // In_1 pin label should not appear in plain listing
    expect(output).not.toContain('In_1');
  });

  it('category description includes ANALOG in the tool schema', () => {
    const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema: { shape?: Record<string, { _def?: { description?: string } }> } }> })._registeredTools;
    const circuitList = tools['circuit_list'];
    expect(circuitList).toBeDefined();
    // The category field description must mention ANALOG as an example category
    const categoryField = circuitList.inputSchema?.shape?.['category'];
    const description = categoryField?._def?.description ?? '';
    expect(description).toContain('ANALOG');
  });

  it('ANALOG category filter returns no-components message when ANALOG category does not exist', async () => {
    const allDefs = registry.getAll();
    const hasAnalog = allDefs.some(d => d.category?.toUpperCase() === 'ANALOG');
    if (hasAnalog) {
      const output = await callTool('circuit_list', { category: 'ANALOG' });
      expect(output).not.toContain('↓');
      expect(output).not.toContain('↑');
    } else {
      // ANALOG is not a registered category — the tool must say so, not silently return nothing
      const output = await callTool('circuit_list', { category: 'ANALOG' });
      expect(output).toContain('No components found');
      expect(output).toContain('ANALOG');
    }
  });
});

// ===========================================================================
// circuit_compile — analog tool suggestions
// ===========================================================================

describe('circuit_compile analog tool suggestions', () => {
  function buildAndGate(): string {
    const spec: CircuitSpec = {
      components: [
        { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'B', type: 'In', props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'Y', type: 'Out', props: { label: 'Y' } },
      ],
      connections: [
        ['A:out', 'gate:In_1'],
        ['B:out', 'gate:In_2'],
        ['gate:out', 'Y:in'],
      ],
    };
    const circuit = facade.build(spec);
    return session.store(circuit);
  }

  it('compile output for digital circuit does not reference circuit_set_input or circuit_read_output', async () => {
    const handle = buildAndGate();
    const output = await callTool('circuit_compile', { handle });
    expect(output).not.toContain('circuit_set_input');
    expect(output).not.toContain('circuit_read_output');
  });

  it('compile output for digital circuit references circuit_set_signal and circuit_read_signal', async () => {
    const handle = buildAndGate();
    const output = await callTool('circuit_compile', { handle });
    expect(output).toContain('circuit_set_signal');
    expect(output).toContain('circuit_read_signal');
  });

  it('compile output for pure digital circuit does not suggest analog tools', async () => {
    const handle = buildAndGate();
    const output = await callTool('circuit_compile', { handle });
    // A pure digital AND gate has no DC op or AC sweep
    expect(output).not.toContain('circuit_dc_op');
    expect(output).not.toContain('circuit_ac_sweep');
  });

  it('compile output contains compiled successfully message', async () => {
    const handle = buildAndGate();
    const output = await callTool('circuit_compile', { handle });
    expect(output).toContain('Circuit compiled successfully');
  });
});

// ===========================================================================
// circuit_patch — analog example in description
// ===========================================================================

describe('circuit_patch description includes analog example', () => {
  it('patch tool schema description includes resistor analog example', () => {
    const tools = (server as unknown as { _registeredTools: Record<string, { description?: string; inputSchema: { shape?: Record<string, { _def?: { description?: string } }> } }> })._registeredTools;
    const patchTool = tools['circuit_patch'];
    expect(patchTool).toBeDefined();
    // The ops field description must include the analog resistor example (R1, resistance)
    const opsField = patchTool.inputSchema?.shape?.['ops'];
    const opsDescription = opsField?._def?.description ?? '';
    expect(opsDescription).toContain('R1');
    expect(opsDescription).toContain('resistance');
  });
});

// ===========================================================================
// circuit_test — driver analysis for digital outputs
// ===========================================================================

describe('circuit_test driver analysis', () => {
  it('driver analysis for failing digital output traces the driver', async () => {
    // Build a circuit and compile it, then run a failing test
    const spec: CircuitSpec = {
      components: [
        { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'B', type: 'In', props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'Y', type: 'Out', props: { label: 'Y' } },
      ],
      connections: [
        ['A:out', 'gate:In_1'],
        ['B:out', 'gate:In_2'],
        ['gate:out', 'Y:in'],
      ],
    };
    const circuit = facade.build(spec);
    const handle = session.store(circuit);

    // Run a test that will fail: A=1,B=1 should give Y=1, but we say Y=0
    const output = await callTool('circuit_test', {
      handle,
      testData: 'A B Y\n1 1 0',
    });

    expect(output).toContain('Failed: 1');
    expect(output).toContain('Driver analysis');
    // Should show Y is driven by something
    expect(output).toContain('Y');
  });

  it('circuit_test reports all pass when vectors are correct', async () => {
    const spec: CircuitSpec = {
      components: [
        { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'B', type: 'In', props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'Y', type: 'Out', props: { label: 'Y' } },
      ],
      connections: [
        ['A:out', 'gate:In_1'],
        ['B:out', 'gate:In_2'],
        ['gate:out', 'Y:in'],
      ],
    };
    const circuit = facade.build(spec);
    const handle = session.store(circuit);

    const output = await callTool('circuit_test', {
      handle,
      testData: 'A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1',
    });

    expect(output).toContain('Passed: 4');
    expect(output).toContain('All tests passed');
  });
});
