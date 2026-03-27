/**
 * MCP tutorial tool registrations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile, mkdir, readFile } from "fs/promises";
import { resolve } from "path";
import type { DefaultSimulatorFacade } from "../../src/headless/default-facade.js";
import type { ComponentRegistry } from "../../src/core/registry.js";
import type { SessionState } from "./tool-helpers.js";
import { serializeCircuitToDig } from "../../src/io/dig-serializer.js";
import type { TutorialManifest } from "../../src/app/tutorial/types.js";
import { validateManifest } from "../../src/app/tutorial/validate.js";
import { listPresets, resolvePaletteSpec } from "../../src/app/tutorial/presets.js";
import type { CircuitSpec } from "../../src/headless/netlist-types.js";

export function registerTutorialTools(
  server: McpServer,
  facade: DefaultSimulatorFacade,
  registry: ComponentRegistry,
  session: SessionState,
): void {
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
    },
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
            "difficulty ('beginner'|'intermediate'|'advanced'), steps (array of TutorialStep).",
        ),
      },
    },
    async ({ manifest }) => {
      const diagnostics = validateManifest(manifest, registry);

      if (diagnostics.length === 0) {
        const m = manifest as TutorialManifest;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Tutorial manifest is valid.`,
                `  ID: ${m.id}`,
                `  Title: ${m.title}`,
                `  Steps: ${m.steps.length}`,
                `  Difficulty: ${m.difficulty}`,
              ].join("\n"),
            },
          ],
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
        isError: errors.length > 0 ? (true as const) : undefined,
      };
    },
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
        '    "mode": "guided",\n' +
        '    "title": "Step 1",\n' +
        '    "instructions": "# Step 1\\nDo this...",\n' +
        '    "palette": "basic-gates",\n' +
        '    "startCircuit": null,\n' +
        '    "goalCircuit": { "components": [...], "connections": [...] },\n' +
        '    "validation": "test-vectors",\n' +
        '    "testData": "A B | Y\\n0 0 | 0\\n..."\n' +
        '  }]\n' +
        '}\n\n' +
        'Step modes:\n' +
        '  "guided" (default) — student must pass validation before advancing. Shows Pre-check + Check buttons.\n' +
        '  "explore" — free navigation, optional checking. Shows Show Solution button if goalCircuit is provided.',
      inputSchema: {
        manifest: z
          .record(z.unknown())
          .describe("Tutorial manifest object (TutorialManifest schema)"),
        outputDir: z
          .string()
          .describe(
            "Output directory path for the tutorial package (e.g. 'tutorials/my-tutorial')",
          ),
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
          isError: true as const,
        };
      }

      const m = manifest as TutorialManifest;
      const lines: string[] = [`Creating tutorial "${m.title}" (${m.steps.length} steps)...\n`];

      // Step 2: Create output directory
      try {
        await mkdir(outputDir, { recursive: true });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create output directory "${outputDir}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }

      // Step 3: Build and verify each step's circuits
      for (let i = 0; i < m.steps.length; i++) {
        const step = m.steps[i]!;
        const stepMode = step.mode ?? 'guided';
        lines.push(`Step ${i + 1}: "${step.title}" (${step.id}) [${stepMode}]`);

        // Build goal circuit if it's a CircuitSpec
        if (step.goalCircuit && typeof step.goalCircuit !== "string") {
          try {
            const goalCircuit = facade.build(step.goalCircuit as CircuitSpec);
            const goalHandle = session.store(goalCircuit);

            // Save goal circuit
            const goalXml = serializeCircuitToDig(goalCircuit, registry);
            const goalPath = `${outputDir}/${step.id}-goal.dig`;
            await writeFile(goalPath, goalXml, "utf-8");
            lines.push(`  Goal circuit built and saved: ${goalPath}`);

            // Verify test vectors against goal circuit
            if (step.testData) {
              try {
                const testEngine = facade.compile(goalCircuit);
                const results = facade.runTests(testEngine, goalCircuit, step.testData);
                if (results.failed > 0) {
                  lines.push(
                    `  WARNING: ${results.failed}/${results.total} test vectors fail against goal circuit!`,
                  );
                  for (const v of results.vectors) {
                    if (!v.passed) {
                      lines.push(
                        `    FAIL: inputs=${JSON.stringify(v.inputs)} expected=${JSON.stringify(v.expectedOutputs)} actual=${JSON.stringify(v.actualOutputs)}`,
                      );
                    }
                  }
                } else {
                  lines.push(
                    `  Tests verified: ${results.passed}/${results.total} pass against goal circuit`,
                  );
                }
              } catch (err) {
                lines.push(
                  `  WARNING: Test verification error: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }

            // Update manifest to reference the .dig file instead of inline spec
            (step as Record<string, unknown>)["goalCircuitFile"] = `${step.id}-goal.dig`;
          } catch (err) {
            lines.push(
              `  ERROR building goal circuit: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Build start circuit if it's a CircuitSpec
        if (step.startCircuit && typeof step.startCircuit !== "string") {
          try {
            const startCircuit = facade.build(step.startCircuit as CircuitSpec);
            const startXml = serializeCircuitToDig(startCircuit, registry);
            const startPath = `${outputDir}/${step.id}-start.dig`;
            await writeFile(startPath, startXml, "utf-8");
            lines.push(`  Start circuit built and saved: ${startPath}`);
            (step as Record<string, unknown>)["startCircuitFile"] = `${step.id}-start.dig`;
          } catch (err) {
            lines.push(
              `  ERROR building start circuit: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Resolve palette spec for informational output
        const resolved = resolvePaletteSpec(step.palette);
        if (resolved) {
          lines.push(
            `  Palette: ${resolved.length} components (${resolved.slice(0, 5).join(", ")}${resolved.length > 5 ? "..." : ""})`,
          );
        } else {
          lines.push(`  Palette: full (no restriction)`);
        }
      }

      // Step 4: Write manifest.json
      const manifestPath = `${outputDir}/manifest.json`;
      await writeFile(manifestPath, JSON.stringify(m, null, 2), "utf-8");
      lines.push(`\nManifest saved: ${manifestPath}`);

      // Step 5: Upsert tutorials/index.json
      try {
        const indexPath = resolve("tutorials/index.json");
        let indexData: { tutorials: Array<Record<string, unknown>> } = { tutorials: [] };
        try {
          const raw = await readFile(indexPath, "utf-8");
          indexData = JSON.parse(raw);
          if (!Array.isArray(indexData.tutorials)) indexData.tutorials = [];
        } catch {
          // File doesn't exist or is invalid — start fresh
        }

        const entry = {
          id: m.id,
          title: m.title,
          description: m.description,
          difficulty: m.difficulty,
          estimatedMinutes: m.estimatedMinutes ?? null,
          stepCount: m.steps.length,
          tags: m.tags ?? [],
          author: m.author ?? null,
          manifestPath: `${outputDir}/manifest.json`,
        };

        const existingIdx = indexData.tutorials.findIndex((t) => t.id === m.id);
        if (existingIdx >= 0) {
          indexData.tutorials[existingIdx] = entry;
          lines.push(`\nUpdated existing entry in tutorials/index.json`);
        } else {
          indexData.tutorials.push(entry);
          lines.push(`\nAdded new entry to tutorials/index.json`);
        }

        await writeFile(indexPath, JSON.stringify(indexData, null, 2), "utf-8");
      } catch (err) {
        lines.push(
          `\nWARNING: Failed to update tutorials/index.json: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

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
      lines.push(`To use: open tutorials.html or load directly with:`);
      lines.push(`  tutorial-viewer.html?manifest=${outputDir}/manifest.json`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
