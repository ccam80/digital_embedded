/**
 * MCP circuit tool registrations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile, readdir } from "fs/promises";
import { dirname } from "path";
import { DefaultSimulatorFacade } from "../../src/headless/default-facade.js";
import type { ComponentRegistry } from "../../src/core/registry.js";
import type { ComponentDefinition } from "../../src/core/registry.js";
import type { CircuitSpec, PatchOp, ComponentDescriptor } from "../../src/headless/netlist-types.js";
import { extractEmbeddedTestData } from "../../src/headless/test-runner.js";
import { serializeCircuit } from "../../src/io/dts-serializer.js";
import { loadWithSubcircuits } from "../../src/io/subcircuit-loader.js";
import { registerSubcircuit, createLiveDefinition } from "../../src/components/subcircuit/subcircuit.js";
import type { SubcircuitDefinition } from "../../src/components/subcircuit/subcircuit.js";
import { testEquivalence } from "../../src/headless/equivalence.js";
import { makeNodeResolver, SessionState } from "./tool-helpers.js";
import { formatDiagnostics, formatNetlist, formatComponentDefinition } from "./formatters.js";

export function registerCircuitTools(
  server: McpServer,
  facade: DefaultSimulatorFacade,
  registry: ComponentRegistry,
  session: SessionState,
): void {
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
        const baseDir = dirname(filePath) || ".";
        const nodeResolver = makeNodeResolver(baseDir);
        const circuit = await loadWithSubcircuits(xml, nodeResolver, registry);
        const handle = session.store(circuit, baseDir);

        const netlist = facade.netlist(circuit);
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
          isError: true as const,
        };
      }
    },
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
        const circuit = session.getCircuit(handle);
        const netlist = facade.netlist(circuit);
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
          isError: true as const,
        };
      }
    },
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
        const circuit = session.getCircuit(handle);
        const diagnostics = facade.validate(circuit);
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
          isError: true as const,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // circuit_describe
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_describe",
    {
      title: "Describe Component Type",
      description:
        "Query the registry for one or more component type definitions: pin layout, property definitions, and category. " +
        "Use this to understand what pins and properties a component has before adding or patching. " +
        "Accepts a single type name or an array of type names for batch discovery.",
      inputSchema: {
        typeName: z
          .union([z.string(), z.array(z.string())])
          .describe(
            'Component type name(s). Single string or array of strings, e.g. "And" or ["And", "Or", "XOr"]',
          ),
      },
    },
    ({ typeName }) => {
      try {
        const typeNames = Array.isArray(typeName) ? typeName : [typeName];

        const found: string[] = [];
        const notFound: string[] = [];

        for (const name of typeNames) {
          const def = facade.describeComponent(name);
          if (!def) {
            notFound.push(name);
          } else {
            found.push(formatComponentDefinition(def));
          }
        }

        if (found.length === 0 && notFound.length > 0) {
          const allNames = registry.getAll().map((d: ComponentDefinition) => d.name);
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Component type(s) not found in registry: ${notFound.map((n) => `"${n}"`).join(", ")}`,
                  ``,
                  `Available component types (${allNames.length}):`,
                  allNames.join(", "),
                ].join("\n"),
              },
            ],
            isError: true as const,
          };
        }

        const sections: string[] = [...found];

        if (notFound.length > 0) {
          sections.push(
            `\nNot found: ${notFound.map((n) => `"${n}"`).join(", ")}`,
          );
        }

        return {
          content: [{ type: "text" as const, text: sections.join("\n---\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
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
        "Optionally filter by category name. " +
        "Set include_pins to true to see pin labels inline, collapsing the list+describe workflow into one call.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe(
            'Optional category filter, e.g. "LOGIC", "IO", "MEMORY", "WIRING", "ANALOG". Omit to list all.',
          ),
        include_pins: z
          .boolean()
          .optional()
          .describe(
            "When true, include pin labels for each component type inline. " +
            "Collapses the list+describe workflow into one call.",
          ),
      },
    },
    ({ category, include_pins }) => {
      const allDefs = registry.getAll();
      const byCategory = new Map<string, ComponentDefinition[]>();
      for (const def of allDefs) {
        const cat = def.category ?? "UNCATEGORIZED";
        if (category && cat.toUpperCase() !== category.toUpperCase()) continue;
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(def);
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
      for (const [cat, defs] of [...byCategory.entries()].sort()) {
        if (include_pins) {
          const parts = defs.sort((a, b) => a.name.localeCompare(b.name)).map((def) => {
            if (!def.pinLayout || def.pinLayout.length === 0) return def.name;
            const pinStr = def.pinLayout.map((p) => p.label).join(" ");
            return `${def.name} (${pinStr})`;
          });
          lines.push(`${cat}: ${parts.join(", ")}`);
        } else {
          lines.push(`${cat}: ${defs.sort((a, b) => a.name.localeCompare(b.name)).map((d) => d.name).join(", ")}`);
        }
      }
      lines.push(
        `\nTotal: ${[...byCategory.values()].reduce((s, v) => s + v.length, 0)} component types`,
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
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
              "{op:'set', target:'gate1', props:{bitWidth:16}} | " +
              "{op:'set', target:'R1', props:{resistance:10000}} | " +
              "{op:'add', spec:{id:'g2',type:'And'}, connect:{A:'in1:out'}} | " +
              "{op:'remove', target:'gate1'} | " +
              "{op:'connect', from:'in1:out', to:'gate:A'} | " +
              "{op:'disconnect', pin:'gate:A'} | " +
              "{op:'replace', target:'gate1', newType:'Or'}",
          ),
        scope: z
          .string()
          .optional()
          .describe("Optional hierarchy scope for subcircuit editing, e.g. 'MCU/sysreg'"),
      },
    },
    async ({ handle, ops, scope }) => {
      try {
        const circuit = session.getCircuit(handle);

        // On-demand subcircuit registration: if any 'add' op references a .dig
        // type not yet in the registry, load it from the circuit's source dir.
        const sourceDir = session.circuitSourceDirs.get(handle);
        if (sourceDir) {
          for (const op of ops as unknown as PatchOp[]) {
            if (op.op === "add" && op.spec?.type?.endsWith(".dig")) {
              const typeName = op.spec.type;
              if (registry.get(typeName) === undefined) {
                const nodeResolver = makeNodeResolver(sourceDir);
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

        const result = facade.patch(
          circuit,
          ops as unknown as PatchOp[],
          scope ? { scope } : undefined,
        );
        const lines: string[] = [];

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
            : `Patch applied.\n\n${formatDiagnostics(result.diagnostics)}`,
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
          isError: true as const,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // circuit_build
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_build",
    {
      title: "Build Circuit from Spec",
      description:
        "Create a new circuit from a declarative specification. Works with digital, analog, and mixed-signal circuits. " +
        "No coordinates required — the builder auto-positions components and auto-routes wires. " +
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
                    .describe(
                      "Optional properties — use internal keys from circuit_describe (e.g. bitWidth, label, inputCount). XML-convention keys (e.g. Bits, Inputs) are also accepted and auto-translated.",
                    ),
                  layout: z
                    .object({
                      col: z
                        .number()
                        .int()
                        .min(0)
                        .optional()
                        .describe("Pin to column (0 = leftmost)"),
                      row: z
                        .number()
                        .int()
                        .min(0)
                        .optional()
                        .describe("Pin to row within column (0 = topmost)"),
                    })
                    .optional()
                    .describe(
                      "Optional layout constraints. col pins the column, row pins vertical position. Either/both/neither.",
                    ),
                }),
              )
              .describe("Components to create"),
            connections: z
              .array(z.tuple([z.string(), z.string()]))
              .describe(
                'Connections as pairs of "id:pin" addresses, e.g. ["A:out", "gate:A"]',
              ),
          })
          .describe("Declarative circuit specification"),
      },
    },
    ({ spec }) => {
      try {
        const circuit = facade.build(spec as CircuitSpec);
        const handle = session.store(circuit);

        const netlist = facade.netlist(circuit);
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
          isError: true as const,
        };
      }
    },
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
        "Works with digital, analog, and mixed-signal circuits. " +
        "Fails if the circuit has combinational loops, unconnected required pins, or other structural errors. " +
        "You must fix all diagnostics from circuit_validate before compiling.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
      },
    },
    ({ handle }) => {
      try {
        const circuit = session.getCircuit(handle);
        const coordinator = facade.compile(circuit);
        session.storeEngine(handle, coordinator);

        const signals = facade.readAllSignals(coordinator);
        const signalCount = Object.keys(signals).length;

        const netlist = facade.netlist(circuit);
        const hasAnalog = coordinator.supportsDcOp() || coordinator.supportsAcSweep();
        const simTools = hasAnalog
          ? `Use circuit_step, circuit_set_signal, circuit_read_signal for interactive simulation. For analog analysis: circuit_dc_op, circuit_ac_sweep.`
          : `Use circuit_step, circuit_set_signal, circuit_read_signal for interactive simulation.`;
        const lines = [
          `Circuit compiled successfully.`,
          `Components: ${netlist.components.length}`,
          `Nets: ${netlist.nets.length}`,
          `Labeled signals: ${signalCount}`,
          `Timing model: ${coordinator.timingModel}`,
          `DC op available: ${coordinator.supportsDcOp()}`,
          `AC sweep available: ${coordinator.supportsAcSweep()}`,
          ``,
          simTools,
        ];
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Compilation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
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
        "If testData is provided, it is used as the test vector source (test vector format). " +
        "Otherwise, test data is extracted from Testcase components embedded in the circuit. " +
        "Returns pass/fail counts and details of any failing vectors.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
        testData: z
          .string()
          .optional()
          .describe(
            "Optional test vector string in test vector format. " +
              "If omitted, uses Testcase components embedded in the circuit.",
          ),
      },
    },
    async ({ handle, testData }) => {
      try {
        const circuit = session.getCircuit(handle);
        const resolvedData = testData ?? extractEmbeddedTestData(circuit);
        if (resolvedData === null || resolvedData.trim().length === 0) {
          throw new Error(
            "No test data available: circuit contains no Testcase components and no external test data was provided.",
          );
        }
        // Use a dedicated facade for test compilation to avoid corrupting
        // the shared facade's internal coordinator state and leaking engines.
        const testFacade = new DefaultSimulatorFacade(registry);
        const engine = testFacade.compile(circuit);
        let results;
        try {
          results = await testFacade.runTests(engine, circuit, resolvedData);
        } finally {
          testFacade.invalidate();
        }

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
            const v = failingVectors[i]!;
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

          // Driver analysis: trace what drives each failing output one level deep
          const netlist = facade.netlist(circuit);
          const compByLabel = new Map<string, ComponentDescriptor>();
          for (const comp of netlist.components) {
            if (comp.label) compByLabel.set(comp.label, comp);
          }

          const failingOutputs = new Set<string>();
          for (const v of failingVectors) {
            for (const label of Object.keys(v.expectedOutputs)) {
              if (v.actualOutputs[label] !== v.expectedOutputs[label]) {
                failingOutputs.add(label);
              }
            }
          }

          if (failingOutputs.size > 0) {
            lines.push(`\nDriver analysis for failing outputs:`);
            for (const outLabel of failingOutputs) {
              const outComp = compByLabel.get(outLabel);
              if (!outComp) {
                lines.push(`  ${outLabel}: component not found in netlist`);
                continue;
              }
              const isAnalogComp = outComp.pins.every(p => p.domain === 'analog');
              if (isAnalogComp) {
                // Analog: show all connected components without directional language
                const connectedPins = outComp.pins.flatMap(p => p.connectedTo);
                if (connectedPins.length === 0) {
                  lines.push(`  ${outLabel}: no connected components`);
                } else {
                  const connected = connectedPins
                    .map(p => `${p.componentLabel} (${p.componentType})`)
                    .join(', ');
                  lines.push(`  ${outLabel}: connected to ${connected}`);
                }
              } else {
                // Digital: trace INPUT pin to its driver one hop
                const inPin = outComp.pins.find(p => p.direction === 'INPUT');
                if (!inPin || inPin.connectedTo.length === 0) {
                  lines.push(`  ${outLabel}: unconnected input`);
                  continue;
                }
                const driver = inPin.connectedTo[0]!;
                const driverComp = netlist.components[driver.componentIndex];
                const driverInputs = driverComp?.pins
                  .filter(p => p.direction === 'INPUT' && p.connectedTo.length > 0)
                  .map(p => `${p.label}←${p.connectedTo[0]!.componentLabel}`)
                  .join(', ');
                lines.push(
                  `  ${outLabel} ← ${driver.componentLabel}:${driver.pinLabel}` +
                  ` (${driverComp?.typeId ?? driver.componentType}` +
                  `${driverInputs ? ', inputs: ' + driverInputs : ''})`,
                );
              }
            }
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
          isError: true as const,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // circuit_save
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_save",
    {
      title: "Save Circuit",
      description:
        "Serialize a circuit to .dts JSON format and write it to a file. " +
        "When save_all is true, also copies all .dts subcircuit files from the source directory " +
        "into the output directory, so the full circuit hierarchy is self-contained.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
        path: z.string().describe("Output file path (e.g. 'output/my-circuit.dts')"),
        save_all: z
          .boolean()
          .optional()
          .describe(
            "When true, also copies all .dts files from the circuit's source directory " +
              "into the output directory. Use this to save a complete circuit hierarchy.",
          ),
      },
    },
    async ({ handle, path: filePath, save_all }) => {
      try {
        const circuit = session.getCircuit(handle);
        const json = serializeCircuit(circuit);
        await writeFile(filePath, json, "utf-8");

        const lines = [
          `Circuit saved to: ${filePath}`,
          `Format: .dts JSON (${json.length} bytes)`,
        ];

        if (save_all) {
          const outDir = dirname(filePath);
          const sourceDir = session.circuitSourceDirs.get(handle);
          if (!sourceDir) {
            lines.push(
              `\nWarning: save_all requested but circuit has no source directory ` +
                `(it was built in memory). Only the main circuit was saved.`,
            );
          } else {
            const entries = await readdir(sourceDir);
            const dtsFiles = entries.filter(
              (f) => f.endsWith(".dts") && f !== filePath.split(/[/\\]/).pop(),
            );
            let copied = 0;
            for (const f of dtsFiles) {
              const srcPath = sourceDir + "/" + f;
              const dstPath = outDir + "/" + f;
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
          isError: true as const,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // circuit_test_equivalence
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_test_equivalence",
    {
      title: "Test Circuit Equivalence",
      description:
        "Check if two digital circuits are behaviorally equivalent by exhaustively testing all input combinations. " +
        "Digital-only: uses binary exhaustive search over In/Clock/Out components. Not applicable to analog or mixed-signal circuits. " +
        "Both circuits must have the same In/Out labels. Practical for circuits with up to ~16 total input bits. " +
        "Returns whether they match, with details of the first mismatch if they don't.",
      inputSchema: {
        handleA: z.string().describe("Handle of the first circuit"),
        handleB: z.string().describe("Handle of the second circuit"),
        maxInputBits: z
          .number()
          .optional()
          .describe(
            "Maximum total input bits to test exhaustively (default: 16, max: 20)",
          ),
      },
    },
    async ({ handleA, handleB, maxInputBits }) => {
      try {
        const circuitA = session.getCircuit(handleA);
        const circuitB = session.getCircuit(handleB);

        const result = testEquivalence(circuitA, circuitB, registry, maxInputBits);

        if (result.mismatches === -1) {
          // Limit exceeded — not an equivalence result, just a bounds error
          return {
            content: [
              {
                type: "text" as const,
                text: result.firstMismatch ?? "Input bit limit exceeded.",
              },
            ],
            isError: true as const,
          };
        } else if (result.equivalent) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Circuits are behaviorally equivalent.`,
                  `Tested ${result.totalCombinations} input combinations across ${result.inputLabels.length} inputs and ${result.outputLabels.length} outputs.`,
                  `Inputs: ${result.inputLabels.join(", ")}`,
                  `Outputs: ${result.outputLabels.join(", ")}`,
                ].join("\n"),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Circuits are NOT equivalent.`,
                  `Found ${result.mismatches} mismatches out of ${result.totalCombinations * result.outputLabels.length} output checks.`,
                  `First mismatch: ${result.firstMismatch}`,
                ].join("\n"),
              },
            ],
            isError: true as const,
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Equivalence test error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );
}
