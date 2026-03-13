/**
 * Circuit MCP Server
 *
 * Exposes the headless circuit API as Model Context Protocol tools.
 * This is the primary interface for LLM agents to interact with circuits.
 *
 * Run with: npx tsx scripts/circuit-mcp-server.ts
 * The server listens on stdin/stdout using the MCP stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, readdir } from "fs/promises";
import { dirname } from "path";
import { createDefaultRegistry } from "../src/components/register-all.js";
import { CircuitBuilder } from "../src/headless/builder.js";
import { SimulationLoader } from "../src/headless/loader.js";
import { SimulationRunner } from "../src/headless/runner.js";
import type { Circuit } from "../src/core/circuit.js";
import type { Diagnostic, ComponentDescriptor, NetDescriptor, PinDescriptor, Netlist } from "../src/headless/netlist-types.js";
import type { ComponentDefinition } from "../src/core/registry.js";
import type { CircuitSpec, PatchOp } from "../src/headless/netlist-types.js";
import { serializeCircuit } from "../src/io/save.js";
import { parseDigXml } from "../src/io/dig-parser.js";
import { loadDigCircuit } from "../src/io/dig-loader.js";
import { loadWithSubcircuits } from "../src/io/subcircuit-loader.js";
import { NodeResolver } from "../src/io/file-resolver.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const circuits = new Map<string, Circuit>();
let handleCounter = 0;

function nextHandle(): string {
  return `c${handleCounter++}`;
}

function getCircuit(handle: string): Circuit {
  const circuit = circuits.get(handle);
  if (!circuit) {
    throw new Error(`No circuit found for handle "${handle}". Use circuit_load or circuit_build first.`);
  }
  return circuit;
}

// ---------------------------------------------------------------------------
// Registry + builder + loader + runner (initialized once)
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();
const builder = new CircuitBuilder(registry);
const loader = new SimulationLoader(registry);
const runner = new SimulationRunner(registry);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "Diagnostics: none";

  const lines: string[] = [`Diagnostics (${diagnostics.length}):`];
  for (const d of diagnostics) {
    const severity = d.severity.toUpperCase();
    lines.push(`  ${severity} ${d.code}: ${d.message}`);
    if (d.fix) {
      lines.push(`    -> Fix: ${d.fix}`);
    }
    if (d.pins && d.pins.length > 0) {
      const pinList = d.pins
        .map((p) => `${p.componentLabel}:${p.pinLabel} [${p.declaredWidth}-bit, ${p.pinDirection}]`)
        .join(", ");
      lines.push(`    -> Pins: ${pinList}`);
    }
  }
  return lines.join("\n");
}

function formatNetlist(netlist: Netlist): string {
  const lines: string[] = [];

  // Components section
  lines.push(`Components (${netlist.components.length}):`);
  for (const comp of netlist.components) {
    const label = comp.label ? ` "${comp.label}"` : "";
    const pinSummary = comp.pins
      .map((p: PinDescriptor) => `${p.label}[${p.bitWidth}-bit, ${p.direction}]`)
      .join(", ");
    lines.push(`  [${comp.index}] ${comp.typeId}${label} — pins: ${pinSummary}`);
  }

  lines.push("");

  // Nets section
  const connectedNets = netlist.nets.filter((n: NetDescriptor) => n.pins.length > 0);
  lines.push(`Nets (${connectedNets.length}):`);
  for (const net of connectedNets) {
    const width = net.inferredWidth !== null ? `${net.inferredWidth}-bit` : "width-conflict";
    lines.push(`  Net #${net.netId} [${width}, ${net.pins.length} pins]:`);
    for (const pin of net.pins) {
      lines.push(`    ${pin.componentLabel}:${pin.pinLabel} [${pin.declaredWidth}-bit, ${pin.pinDirection}]`);
    }
  }

  lines.push("");
  lines.push(formatDiagnostics(netlist.diagnostics));

  return lines.join("\n");
}

function formatComponentDefinition(def: ComponentDefinition): string {
  const lines: string[] = [];
  lines.push(`Component: ${def.name}`);
  lines.push(`Category: ${def.category}`);

  if (def.helpText) {
    lines.push(`Help: ${def.helpText}`);
  }

  if (def.propertyDefs && def.propertyDefs.length > 0) {
    lines.push(`\nProperties (${def.propertyDefs.length}):`);
    for (const prop of def.propertyDefs) {
      const parts: string[] = [prop.type];
      if (prop.defaultValue !== undefined) parts.push(`default: ${String(prop.defaultValue)}`);
      if (prop.min !== undefined) parts.push(`min: ${prop.min}`);
      if (prop.max !== undefined) parts.push(`max: ${prop.max}`);
      lines.push(`  ${prop.key} (${parts.join(', ')})`);
      if (prop.description) {
        lines.push(`    ${prop.description}`);
      }
    }
  }

  if (def.pinLayout && def.pinLayout.length > 0) {
    lines.push(`\nPins (${def.pinLayout.length}):`);
    for (const pin of def.pinLayout) {
      lines.push(`  ${pin.label} [${pin.defaultBitWidth}-bit, ${pin.direction}]`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "circuit-simulator", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use this server to load, inspect, build, patch, compile, and test digital logic circuits. " +
      "Always start with circuit_load or circuit_build to get a handle, then use circuit_netlist to inspect topology. " +
      "Addresses use the format 'componentLabel:pinLabel'. Read netlist output to get exact addresses for patches.",
  }
);

// ---------------------------------------------------------------------------
// circuit_load
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_load",
  {
    title: "Load Circuit",
    description:
      "Load a .dig circuit file from disk. Returns a handle for subsequent operations. " +
      "Use circuit_netlist after loading to inspect components and connectivity.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to a .dig circuit file"),
    },
  },
  async ({ path: filePath }) => {
    try {
      const xml = await readFile(filePath, "utf-8");
      // Use subcircuit-aware loader: resolve sibling .dig files from the
      // same directory as the loaded file so hierarchical circuits work.
      const baseDir = dirname(filePath) || ".";
      const nodeResolver = new NodeResolver(
        baseDir + "/",
        (path: string) => readFile(path, "utf-8"),
        (path: string) => readdir(path),
      );
      const circuit = await loadWithSubcircuits(xml, nodeResolver, registry);
      const handle = nextHandle();
      circuits.set(handle, circuit);

      const netlist = builder.netlist(circuit);
      const wireCount = circuit.wires.length;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Circuit loaded successfully.`,
              `Handle: ${handle}`,
              `Components: ${netlist.components.length}`,
              `Wires: ${wireCount}`,
              `Diagnostics: ${netlist.diagnostics.length === 0 ? "none" : netlist.diagnostics.length + " issue(s)"}`,
              ``,
              `Use circuit_netlist with handle "${handle}" for full topology.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error loading circuit: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_netlist
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_netlist",
  {
    title: "Get Circuit Netlist",
    description:
      "Extract the full netlist of a circuit: all components with their pins, all nets showing connectivity, " +
      "and pre-compilation diagnostics. This is the PRIMARY introspection tool. " +
      "Use this to understand circuit topology before making patches.",
    inputSchema: {
      handle: z.string().describe("Circuit handle returned by circuit_load or circuit_build"),
    },
  },
  ({ handle }) => {
    try {
      const circuit = getCircuit(handle);
      const netlist = builder.netlist(circuit);
      return {
        content: [{ type: "text" as const, text: formatNetlist(netlist) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_validate
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_validate",
  {
    title: "Validate Circuit",
    description:
      "Validate circuit structure and return all diagnostics (errors, warnings). " +
      "Returns 'No issues found' if the circuit is valid.",
    inputSchema: {
      handle: z.string().describe("Circuit handle"),
    },
  },
  ({ handle }) => {
    try {
      const circuit = getCircuit(handle);
      const diagnostics = builder.validate(circuit);
      const text =
        diagnostics.length === 0
          ? "No issues found. Circuit is valid."
          : formatDiagnostics(diagnostics);
      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_describe
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_describe",
  {
    title: "Describe Component Type",
    description:
      "Query the registry for a component type's definition: pin layout, property definitions, and category. " +
      "Use this to understand what pins and properties a component has before adding or patching.",
    inputSchema: {
      typeName: z
        .string()
        .describe(
          'Component type name, e.g. "And", "Or", "FlipflopD", "In", "Out", "Add", "Mux"'
        ),
    },
  },
  ({ typeName }) => {
    try {
      const def = builder.describeComponent(typeName);
      if (!def) {
        // List available types to help
        const allNames = registry.getAll().map((d: ComponentDefinition) => d.name);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Component type "${typeName}" not found in registry.`,
                ``,
                `Available component types (${allNames.length}):`,
                allNames.join(", "),
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatComponentDefinition(def) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_list
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_list",
  {
    title: "List Component Types",
    description:
      "List all registered component types grouped by category. " +
      "Use this to discover available components before building circuits. " +
      "Optionally filter by category name.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe(
          'Optional category filter, e.g. "LOGIC", "IO", "MEMORY", "WIRING". Omit to list all.'
        ),
    },
  },
  ({ category }) => {
    const allDefs = registry.getAll();
    const byCategory = new Map<string, string[]>();
    for (const def of allDefs) {
      const cat = def.category ?? "UNCATEGORIZED";
      if (category && cat.toUpperCase() !== category.toUpperCase()) continue;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(def.name);
    }

    if (byCategory.size === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No components found for category "${category}". Available categories: ${[...new Set(allDefs.map((d) => d.category))].sort().join(", ")}`,
          },
        ],
      };
    }

    const lines: string[] = [];
    for (const [cat, names] of [...byCategory.entries()].sort()) {
      lines.push(`${cat}: ${names.sort().join(", ")}`);
    }
    lines.push(`\nTotal: ${[...byCategory.values()].reduce((s, v) => s + v.length, 0)} component types`);

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ---------------------------------------------------------------------------
// circuit_patch
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_patch",
  {
    title: "Patch Circuit",
    description:
      "Apply patch operations to an existing circuit. Operations are applied in order. " +
      "Targets use the same 'componentLabel:pinLabel' addressing as netlist output. " +
      "Supported ops: set (change properties), add (add component), remove (delete component), " +
      "connect (add wire), disconnect (remove wires at pin), replace (swap component type). " +
      "Returns post-patch diagnostics.",
    inputSchema: {
      handle: z.string().describe("Circuit handle"),
      ops: z
        .array(z.record(z.unknown()))
        .describe(
          "Array of patch operations. Each op must have an 'op' field: " +
            "'set' | 'add' | 'remove' | 'connect' | 'disconnect' | 'replace'. " +
            "Examples: " +
            "{op:'set', target:'gate1', props:{Bits:16}} | " +
            "{op:'add', spec:{id:'g2',type:'And'}, connect:{A:'in1:out'}} | " +
            "{op:'remove', target:'gate1'} | " +
            "{op:'connect', from:'in1:out', to:'gate:A'} | " +
            "{op:'disconnect', pin:'gate:A'} | " +
            "{op:'replace', target:'gate1', newType:'Or'}"
        ),
      scope: z
        .string()
        .optional()
        .describe(
          "Optional hierarchy scope for subcircuit editing, e.g. 'MCU/sysreg'"
        ),
    },
  },
  ({ handle, ops, scope }) => {
    try {
      const circuit = getCircuit(handle);
      const diagnostics = builder.patch(circuit, ops as unknown as PatchOp[], scope ? { scope } : undefined);
      const text =
        diagnostics.length === 0
          ? "Patch applied successfully. No issues found."
          : `Patch applied.\n\n${formatDiagnostics(diagnostics)}`;
      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error applying patch: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_build
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_build",
  {
    title: "Build Circuit from Spec",
    description:
      "Create a new circuit from a declarative specification. No coordinates required — " +
      "the builder auto-positions components and auto-routes wires. " +
      "Components are addressed by their spec id, pins by 'id:pinLabel'. " +
      "Returns a handle and post-build diagnostics.",
    inputSchema: {
      spec: z
        .object({
          name: z.string().optional().describe("Optional circuit name"),
          description: z.string().optional().describe("Optional circuit description"),
          components: z
            .array(
              z.object({
                id: z.string().describe("Local identifier for use in connections"),
                type: z.string().describe('Component type, e.g. "And", "In", "Out"'),
                props: z
                  .record(z.unknown())
                  .optional()
                  .describe("Optional properties (Bits, label, Inputs, etc.)"),
              })
            )
            .describe("Components to create"),
          connections: z
            .array(z.tuple([z.string(), z.string()]))
            .describe('Connections as pairs of "id:pin" addresses, e.g. ["A:out", "gate:A"]'),
        })
        .describe("Declarative circuit specification"),
    },
  },
  ({ spec }) => {
    try {
      const circuit = builder.build(spec as CircuitSpec);
      const handle = nextHandle();
      circuits.set(handle, circuit);

      const netlist = builder.netlist(circuit);
      const text = [
        `Circuit built successfully.`,
        `Handle: ${handle}`,
        `Components: ${netlist.components.length}`,
        `Wires: ${circuit.wires.length}`,
        ``,
        formatDiagnostics(netlist.diagnostics),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error building circuit: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_compile
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_compile",
  {
    title: "Compile Circuit",
    description:
      "Compile a circuit into an executable simulation engine. " +
      "Performs topological sort, net ID assignment, and function table construction. " +
      "Fails if the circuit has combinational loops, unconnected required pins, or other structural errors. " +
      "You must fix all diagnostics from circuit_validate before compiling.",
    inputSchema: {
      handle: z.string().describe("Circuit handle"),
    },
  },
  ({ handle }) => {
    try {
      const circuit = getCircuit(handle);
      const engine = runner.compile(circuit);

      // Read all labeled signals to confirm engine is alive
      const signals = runner.readAllSignals(engine);
      const signalCount = signals.size;

      const netlist = builder.netlist(circuit);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Circuit compiled successfully.`,
              `Components: ${netlist.components.length}`,
              `Nets: ${netlist.nets.length}`,
              `Labeled signals: ${signalCount}`,
              ``,
              `Note: The compiled engine is not stored between tool calls.`,
              `Use circuit_test to run test vectors, which compiles internally.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Compilation failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_test
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_test",
  {
    title: "Run Circuit Tests",
    description:
      "Compile the circuit and run test vectors. " +
      "If testData is provided, it is used as the test vector source (Digital test format). " +
      "Otherwise, test data is extracted from Testcase components embedded in the circuit. " +
      "Returns pass/fail counts and details of any failing vectors.",
    inputSchema: {
      handle: z.string().describe("Circuit handle"),
      testData: z
        .string()
        .optional()
        .describe(
          "Optional test vector string in Digital test format. " +
            "If omitted, uses Testcase components embedded in the circuit."
        ),
    },
  },
  ({ handle, testData }) => {
    try {
      const circuit = getCircuit(handle);
      const engine = runner.compile(circuit);
      const results = builder.runTests(engine, circuit, testData);

      const lines: string[] = [
        `Test Results:`,
        `  Passed: ${results.passed}`,
        `  Failed: ${results.failed}`,
        `  Total:  ${results.total}`,
      ];

      const failingVectors = results.vectors.filter((v) => !v.passed);
      if (failingVectors.length > 0) {
        lines.push(`\nFailing vectors (first ${Math.min(failingVectors.length, 10)}):`);
        for (let i = 0; i < Math.min(failingVectors.length, 10); i++) {
          const v = failingVectors[i];
          lines.push(`  Vector #${i + 1}:`);
          const inputStr = Object.entries(v.inputs)
            .map(([k, val]) => `${k}=${val}`)
            .join(", ");
          lines.push(`    Inputs:   ${inputStr || "(none)"}`);
          const expectedStr = Object.entries(v.expectedOutputs)
            .map(([k, val]) => `${k}=${val}`)
            .join(", ");
          lines.push(`    Expected: ${expectedStr || "(none)"}`);
          const actualStr = Object.entries(v.actualOutputs)
            .map(([k, val]) => `${k}=${val}`)
            .join(", ");
          lines.push(`    Actual:   ${actualStr || "(none)"}`);
        }
        if (failingVectors.length > 10) {
          lines.push(`  ... and ${failingVectors.length - 10} more.`);
        }
      }

      if (results.failed === 0) {
        lines.push(`\nAll tests passed.`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Test run failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// circuit_save
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_save",
  {
    title: "Save Circuit",
    description:
      "Serialize a circuit to the native JSON format and write it to a file. " +
      "Note: saves in the native JSON format, not .dig XML format.",
    inputSchema: {
      handle: z.string().describe("Circuit handle"),
      path: z.string().describe("Output file path (e.g. 'output/my-circuit.json')"),
    },
  },
  async ({ handle, path: filePath }) => {
    try {
      const circuit = getCircuit(handle);
      const json = serializeCircuit(circuit);
      await writeFile(filePath, json, "utf-8");
      return {
        content: [
          {
            type: "text" as const,
            text: `Circuit saved to: ${filePath}\nFormat: native JSON (${json.length} bytes)`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error saving circuit: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is running — it reads from stdin and writes to stdout
  // Process will stay alive until the transport closes
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
