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
import { PropertyBag } from "../src/core/properties.js";
import type { CircuitSpec, PatchOp } from "../src/headless/netlist-types.js";
import { executeTests } from "../src/testing/executor.js";
import { parseTestData } from "../src/testing/parser.js";
import { extractEmbeddedTestData } from "../src/headless/test-runner.js";
import { serializeCircuit } from "../src/io/save.js";
import { serializeCircuitToDig } from "../src/io/dig-serializer.js";
import { parseDigXml } from "../src/io/dig-parser.js";
import { loadDigCircuit } from "../src/io/dig-loader.js";
import { loadWithSubcircuits } from "../src/io/subcircuit-loader.js";
import { NodeResolver } from "../src/io/file-resolver.js";
import { registerSubcircuit, createLiveDefinition } from "../src/components/subcircuit/subcircuit.js";
import type { SubcircuitDefinition } from "../src/components/subcircuit/subcircuit.js";
import { scanDigPins, scan74xxPinMap } from "../src/io/dig-pin-scanner.js";
import { join } from "path";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const circuits = new Map<string, Circuit>();
const circuitSourceDirs = new Map<string, string>();
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

/**
 * Determine inputCount for parseTestData by matching header signal names
 * against the circuit's In/Clock component labels (inputs) vs Out labels (outputs).
 * Returns the number of leading header names that are circuit inputs.
 */
function detectInputCount(circuit: Circuit, headerLine: string): number | undefined {
  // Collect circuit input labels (In, Clock components)
  const inputLabels = new Set<string>();
  for (const el of circuit.elements) {
    const def = registry.get(el.typeId);
    if (!def) continue;
    if (def.name === "In" || def.name === "Clock") {
      const label = el.getProperties().get("label") as string | undefined;
      if (label) inputLabels.add(label);
    }
  }
  if (inputLabels.size === 0) return undefined;

  // Parse signal names from header (whitespace-separated, skip comments)
  const names = headerLine.trim().split(/\s+/).filter((n) => n.length > 0 && n !== "#");

  // Count leading names that are circuit inputs
  let count = 0;
  for (const name of names) {
    if (inputLabels.has(name)) {
      count++;
    } else {
      break; // First non-input name marks the boundary
    }
  }
  return count > 0 ? count : undefined;
}

// ---------------------------------------------------------------------------
// Registry + builder + loader + runner (initialized once)
// ---------------------------------------------------------------------------

const LIB_74XX_DIR = join(process.cwd(), "ref", "Digital", "src", "main", "dig", "lib", "DIL Chips", "74xx");
const pinMap74xx = scan74xxPinMap(LIB_74XX_DIR);
const registry = createDefaultRegistry(pinMap74xx);
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

    // Show non-trivial properties (skip label — already shown — and position)
    const propEntries = Object.entries(comp.properties).filter(
      ([k]) => k !== "label" && k !== "position"
    );
    const propSuffix = propEntries.length > 0
      ? ` {${propEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}}`
      : "";

    lines.push(`  [${comp.index}] ${comp.typeId}${label}${propSuffix} — pins: ${pinSummary}`);
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
    // Identify which pins scale with the bitWidth property by checking if
    // the component factory produces wider pins when bitWidth is set.
    const scalingPins = new Set<string>();
    const bwPropDef = def.propertyDefs?.find((p) => p.key === "bitWidth");
    if (bwPropDef) {
      const testWidth = 16;
      const testBag = new PropertyBag();
      testBag.set("bitWidth", testWidth);
      try {
        const testElement = def.factory(testBag);
        for (const pin of testElement.getPins()) {
          if (pin.bitWidth === testWidth) {
            scalingPins.add(pin.label);
          }
        }
      } catch { /* factory may fail with minimal props — skip detection */ }
    }

    lines.push(`\nPins (${def.pinLayout.length}):`);
    for (const pin of def.pinLayout) {
      const scaleNote = scalingPins.has(pin.label) ? " (scales with bitWidth)" : "";
      lines.push(`  ${pin.label} [${pin.defaultBitWidth}-bit, ${pin.direction}]${scaleNote}`);
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
      circuitSourceDirs.set(handle, baseDir);

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
// circuit_describe_file
// ---------------------------------------------------------------------------

server.registerTool(
  "circuit_describe_file",
  {
    title: "Describe .dig File Pins",
    description:
      "Lightweight scan of a .dig file to extract its external pin interface " +
      "(In/Out components with labels, bit widths, and directions) without " +
      "loading the full circuit. Much faster than circuit_load for inspecting " +
      "subcircuit interfaces or unknown .dig files.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to a .dig circuit file"),
    },
  },
  async ({ path: filePath }) => {
    try {
      const xml = await readFile(filePath, "utf-8");
      const pins = scanDigPins(xml);

      if (pins.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No In/Out pins found in "${filePath}". The file may be a top-level circuit (not a subcircuit) or contain no I/O components.`,
            },
          ],
        };
      }

      const inputs = pins.filter((p) => p.direction === "INPUT");
      const outputs = pins.filter((p) => p.direction === "OUTPUT");

      const lines = [
        `File: ${filePath}`,
        `Pins: ${pins.length} (${inputs.length} inputs, ${outputs.length} outputs)`,
        ``,
        `Inputs:`,
        ...inputs.map((p) => `  ${p.label} [${p.defaultBitWidth}-bit]`),
        ``,
        `Outputs:`,
        ...outputs.map((p) => `  ${p.label} [${p.defaultBitWidth}-bit]`),
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error scanning file: ${err instanceof Error ? err.message : String(err)}`,
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
  async ({ handle, ops, scope }) => {
    try {
      const circuit = getCircuit(handle);

      // On-demand subcircuit registration: if any 'add' op references a .dig
      // type not yet in the registry, load it from the circuit's source dir.
      const sourceDir = circuitSourceDirs.get(handle);
      if (sourceDir) {
        for (const op of ops as unknown as PatchOp[]) {
          if (op.op === "add" && op.spec?.type?.endsWith(".dig")) {
            const typeName = op.spec.type;
            if (registry.get(typeName) === undefined) {
              const nodeResolver = new NodeResolver(
                sourceDir + "/",
                (path: string) => readFile(path, "utf-8"),
                (path: string) => readdir(path),
              );
              const sibXml = await readFile(sourceDir + "/" + typeName, "utf-8");
              const sibCircuit = await loadWithSubcircuits(sibXml, nodeResolver, registry);
              const shapeType = sibCircuit.metadata.shapeType || "DEFAULT";
              const subDef = createLiveDefinition(
                sibCircuit,
                shapeType as SubcircuitDefinition["shapeMode"],
                typeName,
              );
              registerSubcircuit(registry, typeName, subDef);
            }
          }
        }
      }

      const result = builder.patch(circuit, ops as unknown as PatchOp[], scope ? { scope } : undefined);
      const lines: string[] = [];

      // Show added component ID mappings so the caller can address them
      const addedEntries = Object.entries(result.addedIds);
      if (addedEntries.length > 0) {
        lines.push("Added components:");
        for (const [specId, instanceId] of addedEntries) {
          lines.push(`  ${specId} → ${instanceId}`);
        }
        lines.push("");
      }

      lines.push(
        result.diagnostics.length === 0
          ? "Patch applied successfully. No issues found."
          : `Patch applied.\n\n${formatDiagnostics(result.diagnostics)}`
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
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
                layout: z
                  .object({
                    col: z.number().int().min(0).optional().describe("Pin to column (0 = leftmost)"),
                    row: z.number().int().min(0).optional().describe("Pin to row within column (0 = topmost)"),
                  })
                  .optional()
                  .describe("Optional layout constraints. col pins the column, row pins vertical position. Either/both/neither."),
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
      const resolvedData = testData ?? extractEmbeddedTestData(circuit);
      if (resolvedData === null || resolvedData.trim().length === 0) {
        throw new Error("No test data available: circuit contains no Testcase components and no external test data was provided.");
      }
      const firstLine = resolvedData.split('\n').find((l) => l.trim().length > 0 && !l.trim().startsWith('#')) ?? '';
      const inputCount = detectInputCount(circuit, firstLine);
      const parsed = parseTestData(resolvedData, inputCount);
      const results = executeTests(runner, engine, circuit, parsed);

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
      "Serialize a circuit to .dig XML format (Digital's native format) and write it to a file. " +
      "When save_all is true, also copies all .dig subcircuit files from the source directory " +
      "into the output directory, so the full circuit hierarchy is self-contained.",
    inputSchema: {
      handle: z.string().describe("Circuit handle"),
      path: z.string().describe("Output file path (e.g. 'output/my-circuit.dig')"),
      save_all: z
        .boolean()
        .optional()
        .describe(
          "When true, also copies all .dig files from the circuit's source directory " +
            "into the output directory. Use this to save a complete circuit hierarchy."
        ),
    },
  },
  async ({ handle, path: filePath, save_all }) => {
    try {
      const circuit = getCircuit(handle);
      const xml = serializeCircuitToDig(circuit, registry);
      await writeFile(filePath, xml, "utf-8");

      const lines = [
        `Circuit saved to: ${filePath}`,
        `Format: .dig XML (${xml.length} bytes)`,
      ];

      // save_all: copy sibling .dig files from the source directory
      if (save_all) {
        const outDir = dirname(filePath);
        const sourceDir = circuitSourceDirs.get(handle);
        if (!sourceDir) {
          lines.push(
            `\nWarning: save_all requested but circuit has no source directory ` +
              `(it was built in memory). Only the main circuit was saved.`
          );
        } else {
          const entries = await readdir(sourceDir);
          const digFiles = entries.filter(
            (f) => f.endsWith(".dig") && f !== filePath.split(/[/\\]/).pop()
          );
          let copied = 0;
          for (const f of digFiles) {
            const srcPath = sourceDir + "/" + f;
            const dstPath = outDir + "/" + f;
            // Don't overwrite the main circuit file we just wrote
            if (dstPath === filePath) continue;
            try {
              const content = await readFile(srcPath, "utf-8");
              await writeFile(dstPath, content, "utf-8");
              copied++;
            } catch {
              lines.push(`  Warning: could not copy ${f}`);
            }
          }
          lines.push(`\nCopied ${copied} subcircuit file(s) from ${sourceDir}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
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
// Tutorial tools
// ---------------------------------------------------------------------------

import { isTutorialManifest } from "../src/tutorial/types.js";
import type { TutorialManifest, TutorialStep, TutorialCircuitSpec } from "../src/tutorial/types.js";
import { validateManifest } from "../src/tutorial/validate.js";
import { listPresets, resolvePaletteSpec } from "../src/tutorial/presets.js";
import { mkdir } from "fs/promises";

// ---- tutorial_list_presets ----

server.registerTool(
  "tutorial_list_presets",
  {
    title: "List Palette Presets",
    description:
      "List all available palette presets with their component names. " +
      "Use preset names in TutorialStep.palette instead of listing components manually.",
    inputSchema: {},
  },
  async () => {
    const presets = listPresets();
    const lines: string[] = [`Palette Presets (${presets.length}):\n`];
    for (const p of presets) {
      if (p.count === 0) {
        lines.push(`  ${p.name} — (no filter, shows all components)`);
      } else {
        lines.push(`  ${p.name} (${p.count} components): ${p.components.join(", ")}`);
      }
    }
    lines.push("");
    lines.push("Usage in TutorialStep.palette:");
    lines.push('  "basic-gates"                              — use preset as-is');
    lines.push('  ["And", "Or", "In", "Out"]                 — explicit list');
    lines.push('  { preset: "basic-gates", add: ["Clock"] }  — preset + extras');
    lines.push('  { preset: "basic-gates", remove: ["Not"] } — preset - exclusions');
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ---- tutorial_validate ----

server.registerTool(
  "tutorial_validate",
  {
    title: "Validate Tutorial Manifest",
    description:
      "Validate a tutorial manifest JSON against the schema and component registry. " +
      "Returns structured diagnostics (errors and warnings). " +
      "Use this before tutorial_create to catch issues early.",
    inputSchema: {
      manifest: z.record(z.unknown()).describe(
        "Tutorial manifest object. See TutorialManifest type for the full schema. " +
        "Required fields: id (string), version (1), title, description, " +
        "difficulty ('beginner'|'intermediate'|'advanced'), steps (array of TutorialStep)."
      ),
    },
  },
  async ({ manifest }) => {
    const diagnostics = validateManifest(manifest, registry);

    if (diagnostics.length === 0) {
      const m = manifest as TutorialManifest;
      return {
        content: [{
          type: "text" as const,
          text: [
            `Tutorial manifest is valid.`,
            `  ID: ${m.id}`,
            `  Title: ${m.title}`,
            `  Steps: ${m.steps.length}`,
            `  Difficulty: ${m.difficulty}`,
          ].join("\n"),
        }],
      };
    }

    const errors = diagnostics.filter((d) => d.severity === "error");
    const warnings = diagnostics.filter((d) => d.severity === "warning");
    const lines: string[] = [
      `Validation found ${errors.length} error(s) and ${warnings.length} warning(s):\n`,
    ];

    for (const d of diagnostics) {
      const prefix = d.severity === "error" ? "ERROR" : "WARN";
      const step = d.stepId ? ` [${d.stepId}]` : "";
      lines.push(`  ${prefix}${step} ${d.code}: ${d.message}`);
      if (d.fix) lines.push(`    Fix: ${d.fix}`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      isError: errors.length > 0,
    };
  }
);

// ---- tutorial_create ----

server.registerTool(
  "tutorial_create",
  {
    title: "Create Tutorial",
    description:
      "Create a complete tutorial package from a manifest. " +
      "Validates the manifest, builds goal circuits from CircuitSpec definitions, " +
      "runs test vectors against goal circuits to verify they pass, " +
      "and writes all files to the output directory.\n\n" +
      "Output structure:\n" +
      "  <outputDir>/manifest.json     — the validated manifest\n" +
      "  <outputDir>/step-id-goal.dig  — goal circuit for each step (if CircuitSpec provided)\n" +
      "  <outputDir>/step-id-start.dig — start circuit for each step (if CircuitSpec provided)\n\n" +
      "Template manifest:\n" +
      '{\n' +
      '  "id": "my-tutorial",\n' +
      '  "version": 1,\n' +
      '  "title": "My Tutorial",\n' +
      '  "description": "A tutorial about...",\n' +
      '  "difficulty": "beginner",\n' +
      '  "steps": [{\n' +
      '    "id": "step-1",\n' +
      '    "title": "Step 1",\n' +
      '    "instructions": "# Step 1\\nDo this...",\n' +
      '    "palette": "basic-gates",\n' +
      '    "startCircuit": null,\n' +
      '    "goalCircuit": { "components": [...], "connections": [...] },\n' +
      '    "validation": "test-vectors",\n' +
      '    "testData": "A B | Y\\n0 0 | 0\\n..."\n' +
      '  }]\n' +
      '}',
    inputSchema: {
      manifest: z.record(z.unknown()).describe("Tutorial manifest object (TutorialManifest schema)"),
      outputDir: z.string().describe("Output directory path for the tutorial package (e.g. 'tutorials/my-tutorial')"),
    },
  },
  async ({ manifest, outputDir }) => {
    // Step 1: Validate
    const diagnostics = validateManifest(manifest, registry);
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      const lines = ["Manifest validation failed:\n"];
      for (const d of errors) {
        const step = d.stepId ? ` [${d.stepId}]` : "";
        lines.push(`  ERROR${step} ${d.code}: ${d.message}`);
        if (d.fix) lines.push(`    Fix: ${d.fix}`);
      }
      lines.push("\nFix these errors and try again.");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: true,
      };
    }

    const m = manifest as TutorialManifest;
    const lines: string[] = [`Creating tutorial "${m.title}" (${m.steps.length} steps)...\n`];

    // Step 2: Create output directory
    try {
      await mkdir(outputDir, { recursive: true });
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Failed to create output directory "${outputDir}": ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }

    // Step 3: Build and verify each step's circuits
    for (let i = 0; i < m.steps.length; i++) {
      const step = m.steps[i]!;
      lines.push(`Step ${i + 1}: "${step.title}" (${step.id})`);

      // Build goal circuit if it's a CircuitSpec
      if (step.goalCircuit && typeof step.goalCircuit !== "string") {
        try {
          const goalCircuit = builder.build(step.goalCircuit as import("../src/headless/netlist-types.js").CircuitSpec);
          const goalHandle = nextHandle();
          circuits.set(goalHandle, goalCircuit);

          // Save goal circuit
          const goalXml = serializeCircuitToDig(goalCircuit, registry);
          const goalPath = `${outputDir}/${step.id}-goal.dig`;
          await writeFile(goalPath, goalXml, "utf-8");
          lines.push(`  Goal circuit built and saved: ${goalPath}`);

          // Verify test vectors against goal circuit
          if (step.testData) {
            try {
              const goalFirstLine = step.testData.split('\n').find((l: string) => l.trim().length > 0 && !l.trim().startsWith('#')) ?? '';
              const goalInputCount = detectInputCount(goalCircuit, goalFirstLine);
              const parsed = parseTestData(step.testData, goalInputCount);
              const testEngine = runner.compile(goalCircuit);
              const results = executeTests(runner, testEngine, goalCircuit, parsed);
              if (results.failed > 0) {
                lines.push(`  WARNING: ${results.failed}/${results.total} test vectors fail against goal circuit!`);
                for (const v of results.vectors) {
                  if (!v.passed) {
                    lines.push(`    FAIL: inputs=${JSON.stringify(v.inputs)} expected=${JSON.stringify(v.expectedOutputs)} actual=${JSON.stringify(v.actualOutputs)}`);
                  }
                }
              } else {
                lines.push(`  Tests verified: ${results.passed}/${results.total} pass against goal circuit`);
              }
            } catch (err) {
              lines.push(`  WARNING: Test verification error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Update manifest to reference the .dig file instead of inline spec
          (step as Record<string, unknown>)["goalCircuitFile"] = `${step.id}-goal.dig`;
        } catch (err) {
          lines.push(`  ERROR building goal circuit: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Build start circuit if it's a CircuitSpec
      if (step.startCircuit && typeof step.startCircuit !== "string") {
        try {
          const startCircuit = builder.build(step.startCircuit as import("../src/headless/netlist-types.js").CircuitSpec);
          const startXml = serializeCircuitToDig(startCircuit, registry);
          const startPath = `${outputDir}/${step.id}-start.dig`;
          await writeFile(startPath, startXml, "utf-8");
          lines.push(`  Start circuit built and saved: ${startPath}`);
          (step as Record<string, unknown>)["startCircuitFile"] = `${step.id}-start.dig`;
        } catch (err) {
          lines.push(`  ERROR building start circuit: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Resolve palette spec for informational output
      const resolved = resolvePaletteSpec(step.palette);
      if (resolved) {
        lines.push(`  Palette: ${resolved.length} components (${resolved.slice(0, 5).join(", ")}${resolved.length > 5 ? "..." : ""})`);
      } else {
        lines.push(`  Palette: full (no restriction)`);
      }
    }

    // Step 4: Write manifest.json
    const manifestPath = `${outputDir}/manifest.json`;
    await writeFile(manifestPath, JSON.stringify(m, null, 2), "utf-8");
    lines.push(`\nManifest saved: ${manifestPath}`);

    // Warnings
    const warnings = diagnostics.filter((d) => d.severity === "warning");
    if (warnings.length > 0) {
      lines.push(`\nWarnings (${warnings.length}):`);
      for (const d of warnings) {
        const step = d.stepId ? ` [${d.stepId}]` : "";
        lines.push(`  WARN${step}: ${d.message}`);
      }
    }

    lines.push(`\nTutorial created successfully.`);
    lines.push(`To use: load manifest.json from the tutorial host, or embed with:`);
    lines.push(`  simulator.html?palette=And,Or,Not&file=${outputDir}/step-1-goal.dig`);

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ---- circuit_test_equivalence ----

server.registerTool(
  "circuit_test_equivalence",
  {
    title: "Test Circuit Equivalence",
    description:
      "Check if two circuits are behaviorally equivalent by exhaustively testing all input combinations. " +
      "Both circuits must have the same In/Out labels. Practical for circuits with up to ~16 total input bits. " +
      "Returns whether they match, with details of the first mismatch if they don't.",
    inputSchema: {
      handleA: z.string().describe("Handle of the first circuit"),
      handleB: z.string().describe("Handle of the second circuit"),
      maxInputBits: z.number().optional().describe("Maximum total input bits to test exhaustively (default: 16, max: 20)"),
    },
  },
  async ({ handleA, handleB, maxInputBits }) => {
    try {
      const circuitA = getCircuit(handleA);
      const circuitB = getCircuit(handleB);

      const engineA = runner.compile(circuitA);
      const engineB = runner.compile(circuitB);

      // Discover In/Out labels from circuit A
      const inputLabels: string[] = [];
      const inputWidths: number[] = [];
      const outputLabels: string[] = [];

      for (const el of circuitA.elements) {
        const def = registry.get(el.typeId);
        if (!def) continue;
        const label = el.getProperty("label") as string;
        if (!label) continue;
        if (def.name === "In" || def.name === "Clock") {
          const bits = (el.getProperty("Bits") as number) || 1;
          inputLabels.push(label);
          inputWidths.push(bits);
        } else if (def.name === "Out") {
          outputLabels.push(label);
        }
      }

      const totalBits = inputWidths.reduce((a, b) => a + b, 0);
      const limit = Math.min(maxInputBits ?? 16, 20);
      if (totalBits > limit) {
        return {
          content: [{
            type: "text" as const,
            text: `Total input bits (${totalBits}) exceeds limit (${limit}). ` +
              `Exhaustive equivalence testing is impractical. Use test vectors instead.`,
          }],
          isError: true,
        };
      }

      const totalCombinations = 1 << totalBits;
      let mismatches = 0;
      let firstMismatch: string | null = null;

      for (let combo = 0; combo < totalCombinations; combo++) {
        // Distribute bits across inputs
        let bitPos = 0;
        for (let i = 0; i < inputLabels.length; i++) {
          const mask = (1 << inputWidths[i]!) - 1;
          const value = (combo >> bitPos) & mask;
          runner.setInput(engineA, inputLabels[i]!, value);
          runner.setInput(engineB, inputLabels[i]!, value);
          bitPos += inputWidths[i]!;
        }

        runner.runToStable(engineA);
        runner.runToStable(engineB);

        // Compare outputs
        for (const label of outputLabels) {
          const outA = runner.readOutput(engineA, label);
          const outB = runner.readOutput(engineB, label);
          if (outA !== outB) {
            mismatches++;
            if (!firstMismatch) {
              const inputState: Record<string, number> = {};
              let bp = 0;
              for (let i = 0; i < inputLabels.length; i++) {
                const mask = (1 << inputWidths[i]!) - 1;
                inputState[inputLabels[i]!] = (combo >> bp) & mask;
                bp += inputWidths[i]!;
              }
              firstMismatch = `Output "${label}": A=${outA}, B=${outB} for inputs ${JSON.stringify(inputState)}`;
            }
          }
        }
      }

      if (mismatches === 0) {
        return {
          content: [{
            type: "text" as const,
            text: [
              `Circuits are behaviorally equivalent.`,
              `Tested ${totalCombinations} input combinations across ${inputLabels.length} inputs and ${outputLabels.length} outputs.`,
              `Inputs: ${inputLabels.join(", ")}`,
              `Outputs: ${outputLabels.join(", ")}`,
            ].join("\n"),
          }],
        };
      } else {
        return {
          content: [{
            type: "text" as const,
            text: [
              `Circuits are NOT equivalent.`,
              `Found ${mismatches} mismatches out of ${totalCombinations * outputLabels.length} output checks.`,
              `First mismatch: ${firstMismatch}`,
            ].join("\n"),
          }],
          isError: true,
        };
      }
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Equivalence test error: ${err instanceof Error ? err.message : String(err)}`,
        }],
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
