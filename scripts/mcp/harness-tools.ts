// harness-tools.ts — MCP tool registration for ngspice comparison harness

import { existsSync } from "fs";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wrapTool } from "./tool-helpers.js";
import { HarnessSessionState } from "./harness-session-state.js";
import { ComparisonSession } from "../../src/solver/analog/__tests__/harness/comparison-session.js";
import { formatNumber, formatComparedValue, suggestComponents } from "./harness-format.js";
import { writeFileSync } from "fs";
import type { SessionSummary, NRPhase } from "../../src/solver/analog/__tests__/harness/types.js";
import { isPoolBacked } from "../../src/solver/analog/element.js";

// ---------------------------------------------------------------------------
// JSON serialization helpers
// ---------------------------------------------------------------------------

function serializeSummary(summary: SessionSummary) {
  return {
    analysis: summary.analysis,
    stepCount: formatComparedValue(summary.stepCount),
    convergence: {
      ours: {
        totalSteps: summary.convergence.ours.totalSteps,
        convergedSteps: summary.convergence.ours.convergedSteps,
        failedSteps: summary.convergence.ours.failedSteps,
        avgIterations: formatNumber(summary.convergence.ours.avgIterations),
        maxIterations: summary.convergence.ours.maxIterations,
        worstStep: (summary.convergence.ours as any).worstStep ?? -1,
      },
      ngspice: {
        totalSteps: summary.convergence.ngspice.totalSteps,
        convergedSteps: summary.convergence.ngspice.convergedSteps,
        failedSteps: summary.convergence.ngspice.failedSteps,
        avgIterations: formatNumber(summary.convergence.ngspice.avgIterations),
        maxIterations: summary.convergence.ngspice.maxIterations,
        worstStep: (summary.convergence.ngspice as any).worstStep ?? -1,
      },
    },
    firstDivergence: summary.firstDivergence
      ? {
          stepIndex: summary.firstDivergence.stepIndex,
          iterationIndex: summary.firstDivergence.iterationIndex,
          simTime: formatNumber(summary.firstDivergence.stepStartTime),
          worstLabel: summary.firstDivergence.worstLabel,
          absDelta: formatNumber(summary.firstDivergence.absDelta),
        }
      : null,
    totals: summary.totals,
  };
}

// ---------------------------------------------------------------------------
// registerHarnessTools
// ---------------------------------------------------------------------------

export function registerHarnessTools(
  server: McpServer,
  harnessState: HarnessSessionState,
): void {
  // -------------------------------------------------------------------------
  // harness_start
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_start",
    {
      title: "Start Comparison Session",
      description:
        "Load a .dts circuit file, initialize both engines (ours + ngspice), " +
        "and return a handle for subsequent tool calls. The SPICE netlist is " +
        "auto-generated from the compiled circuit. Analysis is deferred until harness_run.",
      inputSchema: z.object({
        dtsPath: z.string().describe("Absolute path to the .dts circuit file"),
        dllPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the ngspice shared library (spice.dll / libngspice.so). " +
              "Defaults to NGSPICE_DLL_PATH env var, then the standard build location.",
          ),
        tolerance: z
          .object({
            vAbsTol: z
              .number()
              .positive()
              .optional()
              .describe("Voltage absolute tolerance (V). Default: 1e-6"),
            iAbsTol: z
              .number()
              .positive()
              .optional()
              .describe("Current absolute tolerance (A). Default: 1e-12"),
            relTol: z
              .number()
              .positive()
              .optional()
              .describe("Relative tolerance. Default: 1e-3"),
            qAbsTol: z
              .number()
              .positive()
              .optional()
              .describe("Charge/capacitance tolerance (C/F). Default: 1e-14"),
          })
          .optional()
          .describe("Tolerance overrides. Omit to use SPICE3 defaults."),
        maxOurSteps: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Maximum timestep captures from our engine per transient run. Default: 5000.",
          ),
      }),
    },
    wrapTool("harness_start", async (args) => {
      if (harnessState.size >= 10000) {
        throw new Error(
          "harness_start: too many active sessions, dispose unused handles first",
        );
      }

      // Validate dtsPath
      const dtsPath = resolve(args.dtsPath);
      if (!existsSync(dtsPath)) {
        throw new Error(`harness_start: file not found: ${args.dtsPath}`);
      }

      // Validate dllPath if provided
      if (args.dllPath && !existsSync(resolve(args.dllPath))) {
        throw new Error(
          `harness_start: ngspice DLL not found: ${args.dllPath}. Set NGSPICE_DLL_PATH or pass dllPath.`,
        );
      }

      const session = new ComparisonSession({
        dtsPath: args.dtsPath,
        dllPath: args.dllPath,
        tolerance: args.tolerance,
        maxOurSteps: args.maxOurSteps,
      });

      try {
        await session.init();
      } catch (err) {
        throw new Error(
          `harness_start: circuit compile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const handle = harnessState.store({
        session,
        dtsPath: args.dtsPath,
        createdAt: new Date(),
        lastRunAt: null,
        analysis: null,
      });

      // Build topology output from session internals
      const topology = (session as any)._ourTopology;
      const engine = (session as any)._engine;

      const components = topology.elements.map((el: any) => {
        const engineEl = (engine?.elements ?? [])[el.index];
        const slots: string[] =
          engineEl && isPoolBacked(engineEl)
            ? engineEl.stateSchema.slots.map((s: any) => s.name)
            : [];
        const pins: string[] = el.pinNodeIds.map((nodeId: number) => {
          if (nodeId === 0) return "gnd";
          return topology.nodeLabels.get(nodeId) ?? `node${nodeId}`;
        });
        return {
          label: el.label,
          type: el.type ?? "unknown",
          isNonlinear: el.isNonlinear,
          isReactive: el.isReactive,
          pins,
          slots,
        };
      });

      const nodes: Array<{
        label: string;
        index: number;
        connectedComponents: string[];
      }> = [];
      topology.nodeLabels.forEach((label: string, nodeId: number) => {
        if (nodeId === 0) return; // ground is the reference, excluded from output
        const connectedComponents: string[] = [];
        for (const el of topology.elements) {
          if ((el.pinNodeIds as readonly number[]).includes(nodeId)) {
            connectedComponents.push(el.label);
          }
        }
        nodes.push({ label, index: nodeId, connectedComponents });
      });
      nodes.sort((a, b) => a.index - b.index);

      return JSON.stringify({
        handle,
        status: "ready",
        dtsPath: args.dtsPath,
        topology: {
          matrixSize: topology.matrixSize,
          nodeCount: topology.nodeCount,
          branchCount: topology.branchCount,
          elementCount: topology.elementCount,
          components,
          nodes,
        },
      });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_run
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_run",
    {
      title: "Run Transient Analysis",
      description:
        "Run transient analysis on both engines (ours + ngspice). Runs once; subsequent " +
        "calls with the same handle replace the previous result. Cached results are cleared on re-run.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
        stopTime: z
          .number()
          .positive()
          .optional()
          .describe(
            "Transient stop time in seconds. Default: 1e-5 (10 µs). E.g. 5e-3 for 5 ms.",
          ),
        startTime: z
          .number()
          .min(0)
          .optional()
          .describe("Transient start time in seconds. Default: 0."),
        maxStep: z
          .number()
          .positive()
          .optional()
          .describe("Maximum timestep in seconds. Default: stopTime / 100."),
      }),
    },
    wrapTool("harness_run", async (args) => {
      const entry = harnessState.get(args.handle, "harness_run");

      const { session } = entry;

      const startTime = args.startTime ?? 0;
      const stopTime = args.stopTime ?? 1e-5;
      await session.runTransient(startTime, stopTime, args.maxStep);

      entry.lastRunAt = new Date();
      entry.analysis = "tran";

      const summary = session.getSummary();

      return JSON.stringify({
        handle: args.handle,
        analysis: "tran",
        summary: serializeSummary(summary),
        errors: session.errors,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_describe
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_describe",
    {
      title: "Describe Circuit Topology",
      description:
        "Return full circuit topology metadata for the session — components with " +
        "their pin assignments and slot names, and nodes with connectivity. Does not " +
        "require harness_run to be called first.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
      }),
    },
    wrapTool("harness_describe", async (args) => {
      const entry = harnessState.get(args.handle, "harness_describe");
      const { session } = entry;

      const topology = (session as any)._ourTopology;
      const engine = (session as any)._engine;
      const nodeMap: Array<{
        ourIndex: number;
        ngspiceIndex: number;
        label: string;
        ngspiceName: string;
      }> = (session as any)._nodeMap ?? [];

      const components = topology.elements.map((el: any) => {
        const engineEl = (engine?.elements ?? [])[el.index];
        const slots: string[] =
          engineEl && isPoolBacked(engineEl)
            ? engineEl.stateSchema.slots.map((s: any) => s.name)
            : [];
        const pins = el.pinNodeIds.map((nodeId: number) => ({
          label:
            nodeId === 0
              ? "gnd"
              : topology.nodeLabels.get(nodeId) ?? `node${nodeId}`,
          nodeIndex: nodeId,
        }));
        return {
          label: el.label,
          index: el.index,
          type: el.type ?? "unknown",
          isNonlinear: el.isNonlinear,
          isReactive: el.isReactive,
          pins,
          slots,
        };
      });

      const nodes: Array<{
        label: string;
        index: number;
        connectedComponents: Array<{ label: string; pinLabel: string }>;
      }> = [];
      topology.nodeLabels.forEach((label: string, nodeId: number) => {
        if (nodeId === 0) return; // ground is the reference, excluded from output
        const connectedComponents: Array<{ label: string; pinLabel: string }> =
          [];
        for (const el of topology.elements) {
          const pinIds = el.pinNodeIds as readonly number[];
          for (let p = 0; p < pinIds.length; p++) {
            if (pinIds[p] === nodeId) {
              connectedComponents.push({
                label: el.label,
                pinLabel: label,
              });
            }
          }
        }
        nodes.push({ label, index: nodeId, connectedComponents });
      });
      nodes.sort((a, b) => a.index - b.index);

      return JSON.stringify({
        handle: args.handle,
        matrixSize: topology.matrixSize,
        nodeCount: topology.nodeCount,
        branchCount: topology.branchCount,
        elementCount: topology.elementCount,
        components,
        nodes,
        nodeMapping: nodeMap,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_dispose
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_dispose",
    {
      title: "Dispose Harness Session",
      description:
        "Clean up a session and release all associated resources (FFI allocations, " +
        "captured data buffers, engine instances).",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle to dispose"),
      }),
    },
    wrapTool("harness_dispose", (args) => {
      harnessState.dispose(args.handle);
      return JSON.stringify({ handle: args.handle, success: true });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_session_map
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_session_map",
    {
      title: "Session Map",
      description:
        "Return the paired session shape: step counts, per-step attempt lists, " +
        "and timing for both engines. Lightweight — no iteration data included. " +
        "Use harness_get_step for per-step detail and harness_get_attempt for iterations.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
      }),
    },
    wrapTool("harness_session_map", async (args) => {
      const entry = harnessState.get(args.handle, "harness_session_map");
      if (!entry.analysis) {
        throw new Error("harness_session_map: run harness_run first");
      }
      const map = entry.session.sessionMap();
      return JSON.stringify({ handle: args.handle, sessionMap: map });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_get_step
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_get_step",
    {
      title: "Get Step Detail",
      description:
        "Return paired attempt summaries and divergence norms for one step. " +
        "Query by index (positional) or by simulation time on a chosen side.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
        index: z.number().int().min(0).optional().describe(
          "Step index (0-based). Mutually exclusive with 'time'.",
        ),
        time: z.number().optional().describe(
          "Simulation time in seconds — finds the nearest step by stepEndTime. " +
          "Mutually exclusive with 'index'.",
        ),
        side: z.enum(["ours", "ngspice"]).optional().describe(
          "Which engine timeline to search when using 'time'. Default: 'ours'.",
        ),
      }),
    },
    wrapTool("harness_get_step", async (args) => {
      const entry = harnessState.get(args.handle, "harness_get_step");
      if (!entry.analysis) {
        throw new Error("harness_get_step: run harness_run first");
      }
      if (args.index !== undefined && args.time !== undefined) {
        throw new Error("harness_get_step: provide either 'index' or 'time', not both");
      }
      if (args.index === undefined && args.time === undefined) {
        throw new Error("harness_get_step: provide 'index' or 'time'");
      }
      const query = args.index !== undefined
        ? { index: args.index }
        : { time: args.time!, side: args.side as "ours" | "ngspice" | undefined };
      const detail = entry.session.getStep(query);
      return JSON.stringify({ handle: args.handle, step: detail });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_get_attempt
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_get_attempt",
    {
      title: "Get Attempt Detail",
      description:
        "Return paired per-iteration data for a specific NR solve attempt within a step. " +
        "Identifies the attempt by step index, phase name, and position within that phase. " +
        "Supports iteration range and pagination.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
        stepIndex: z.number().int().min(0).describe("Step index (0-based)"),
        phase: z.enum([
          "dcopInitJct", "dcopInitFloat",
          "dcopDirect", "dcopGminDynamic", "dcopGminSpice3", "dcopSrcSweep",
          "tranInit", "tranPredictor", "tranNR", "tranNrRetry", "tranLteRetry",
        ] as [NRPhase, ...NRPhase[]]).describe("NR phase name"),
        phaseAttemptIndex: z.number().int().min(0).describe(
          "0-based index within attempts of this phase (usually 0).",
        ),
        iterationRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional().describe(
          "Inclusive [from, to] iteration indices within the attempt.",
        ),
        offset: z.number().int().min(0).optional().describe("Pagination offset. Default: 0."),
        limit: z.number().int().min(1).optional().describe("Maximum iterations to return."),
      }),
    },
    wrapTool("harness_get_attempt", async (args) => {
      const entry = harnessState.get(args.handle, "harness_get_attempt");
      if (!entry.analysis) {
        throw new Error("harness_get_attempt: run harness_run first");
      }
      const detail = entry.session.getAttempt({
        stepIndex: args.stepIndex,
        phase: args.phase as NRPhase,
        phaseAttemptIndex: args.phaseAttemptIndex,
        iterationRange: args.iterationRange as [number, number] | undefined,
        limit: args.limit,
        offset: args.offset,
      });
      return JSON.stringify({ handle: args.handle, attempt: detail });
    }),
  );

  // harness_query and harness_compare_matrix removed — replaced by harness_session_map / harness_get_step / harness_get_attempt

  // -------------------------------------------------------------------------
  // harness_export
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_export",
    {
      title: "Export Session Report",
      description:
        "Serialize the full session (or a filtered subset) to a self-contained JSON object. " +
        "Useful for persisting results for offline analysis or sharing between agents.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
        includeAllSteps: z.boolean().optional().describe(
          "When true, include all step data. When false (default), include only the summary and divergent steps.",
        ),
        onlyDivergences: z.boolean().optional().describe(
          "When true, only export steps and iterations that contain at least one out-of-tolerance comparison. " +
          "Overrides includeAllSteps.",
        ),
        path: z.string().optional().describe(
          "If provided, write the JSON to this file path in addition to returning it inline.",
        ),
      }),
    },
    wrapTool("harness_export", async (args) => {
      const entry = harnessState.get(args.handle, "harness_export");
      const { session } = entry;

      if (!entry.analysis) {
        throw new Error(`harness_export: run harness_run first before exporting`);
      }

      const topology = (session as any)._ourTopology;
      const engine = (session as any)._engine;
      const summary = session.getSummary();

      // Build topology components (detailed)
      const components = topology.elements.map((el: any) => {
        const engineEl = (engine?.elements ?? [])[el.index];
        const slots: string[] =
          engineEl && isPoolBacked(engineEl)
            ? engineEl.stateSchema.slots.map((s: any) => s.name)
            : [];
        const pins = el.pinNodeIds.map((nodeId: number) => ({
          label:
            nodeId === 0
              ? "gnd"
              : topology.nodeLabels.get(nodeId) ?? `node${nodeId}`,
          nodeIndex: nodeId,
        }));
        return {
          label: el.label,
          index: el.index,
          type: el.type ?? "unknown",
          isNonlinear: el.isNonlinear,
          isReactive: el.isReactive,
          pins,
          slots,
        };
      });

      const nodes: Array<{
        label: string;
        index: number;
        connectedComponents: Array<{ label: string; pinLabel: string }>;
      }> = [];
      topology.nodeLabels.forEach((label: string, nodeId: number) => {
        if (nodeId === 0) return;
        const connectedComponents: Array<{ label: string; pinLabel: string }> = [];
        for (const el of topology.elements) {
          const pinIds = el.pinNodeIds as readonly number[];
          for (let p = 0; p < pinIds.length; p++) {
            if (pinIds[p] === nodeId) {
              connectedComponents.push({ label: el.label, pinLabel: label });
            }
          }
        }
        nodes.push({ label, index: nodeId, connectedComponents });
      });
      nodes.sort((a, b) => a.index - b.index);

      // Build steps using toJSON
      const sessionReport = session.toJSON({
        includeAllSteps: args.includeAllSteps,
        onlyDivergences: args.onlyDivergences,
      });

      // Convert steps to export format
      const steps = sessionReport.steps.map((s: any) => ({
        stepIndex: s.stepIndex,
        simTime: s.simTime,
        dt: s.dt,
        converged: typeof s.converged === "object" ? s.converged.ours : s.converged,
        iterationCount: typeof s.iterationCount === "object" ? s.iterationCount.ours : s.iterationCount,
        divergences: [],
      }));

      const sizeBytes = JSON.stringify(steps).length;

      const output: Record<string, any> = {
        handle: args.handle,
        exportedAt: new Date().toISOString(),
        dtsPath: entry.dtsPath,
        analysis: entry.analysis,
        summary: serializeSummary(summary),
        topology: { components, nodes },
        steps,
        sizeBytes,
      };

      if (args.path) {
        try {
          writeFileSync(args.path, JSON.stringify(output, null, 2), "utf-8");
          output.writtenTo = args.path;
        } catch (err) {
          throw new Error(
            `harness_export: failed to write to ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return JSON.stringify(output);
    }),
  );
}
