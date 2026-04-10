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
import type { SessionSummary } from "../../src/solver/analog/__tests__/harness/types.js";
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
          simTime: formatNumber(summary.firstDivergence.simTime),
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
      title: "Run Analysis",
      description:
        "Execute the analysis on both engines. Runs once; subsequent calls with the " +
        "same handle replace the previous result. Cached results are cleared on re-run.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
        analysis: z
          .enum(["dcop", "tran"])
          .describe(
            "'dcop' for DC operating point. 'tran' for transient analysis.",
          ),
        stopTime: z
          .number()
          .positive()
          .optional()
          .describe(
            "Transient stop time in seconds (required for tran). E.g. 5e-3 for 5 ms.",
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

      if (args.analysis === "tran" && args.stopTime === undefined) {
        throw new Error("harness_run: stopTime is required for tran analysis");
      }

      const { session } = entry;

      if (args.analysis === "dcop") {
        await session.runDcOp();
      } else {
        const startTime = args.startTime ?? 0;
        await session.runTransient(startTime, args.stopTime!, args.maxStep);
      }

      entry.lastRunAt = new Date();
      entry.analysis = args.analysis;

      const summary = session.getSummary();

      return JSON.stringify({
        handle: args.handle,
        analysis: args.analysis,
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
  // harness_query
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_query",
    {
      title: "Query Harness Data",
      description:
        "The primary data-extraction tool. Dispatches to the appropriate " +
        "ComparisonSession method based on the presence and combination of input fields. " +
        "All result collections are paginated with offset/limit.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
        component: z.string().optional().describe("Component label to query (e.g. 'Q1'). Case-insensitive."),
        node: z.string().optional().describe("Node label to trace (e.g. 'Q1:C'). Case-insensitive."),
        step: z.number().int().min(0).optional().describe("Step index to inspect."),
        deviceType: z.string().optional().describe("Filter by device type (e.g. 'bjt', 'diode')."),
        type: z.literal("summary").optional().describe("Return session summary."),
        slots: z.array(z.string()).optional().describe("Glob patterns for state slot names."),
        iterations: z.boolean().optional().describe("When true and step is set, return per-iteration data."),
        stateHistory: z.boolean().optional().describe("When true, return state history for component+step."),
        integrationCoefficients: z.boolean().optional().describe("When true and step is set, return integration method coefficients."),
        limiting: z.boolean().optional().describe("When true with component+step+iteration, return limiting data."),
        convergence: z.boolean().optional().describe("When true with step+iteration, return per-element convergence flags."),
        filter: z.enum(["all", "divergences", "worst"]).optional().describe("'all', 'divergences', or 'worst'. Default: 'all'."),
        worstN: z.number().int().min(1).optional().describe("When filter='worst', number of entries to return. Default: 10."),
        stepRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional().describe("Inclusive [from, to] step index range."),
        timeRange: z.tuple([z.number(), z.number()]).optional().describe("Inclusive [from, to] simulation time range in seconds."),
        iteration: z.number().int().min(0).optional().describe("Specific NR iteration index within a step (0-based)."),
        offset: z.number().int().min(0).optional().describe("Result page offset. Default: 0."),
        limit: z.number().int().min(1).optional().describe("Maximum entries to return."),
      }),
    },
    wrapTool("harness_query", async (args) => {
      const entry = harnessState.get(args.handle, "harness_query");
      const { session } = entry;

      // Check analysis has been run
      if (!entry.analysis) {
        throw new Error(`harness_query: run harness_run first`);
      }

      // Conflict detection
      if (args.component && args.node) {
        throw new Error(`harness_query: ambiguous — cannot combine component and node.`);
      }
      if (args.iterations && args.stateHistory) {
        throw new Error(`harness_query: ambiguous — cannot combine iterations and stateHistory.`);
      }
      if (args.limiting && args.convergence) {
        throw new Error(`harness_query: ambiguous — cannot combine limiting and convergence.`);
      }
      if (args.integrationCoefficients && args.iterations) {
        throw new Error(`harness_query: ambiguous — cannot combine integrationCoefficients and iterations.`);
      }

      const offset = args.offset ?? 0;
      const topology = (session as any)._ourTopology;
      const totalSteps: number = (session as any)._ourSession?.steps?.length ?? 0;

      // Validate step range if provided
      if (args.step !== undefined && totalSteps > 0 && args.step >= totalSteps) {
        throw new Error(
          `harness_query: step ${args.step} out of range [0, ${totalSteps - 1}]. Run has ${totalSteps} steps.`,
        );
      }

      // Helper: validate component label
      function requireComponent(label: string): string {
        const upper = label.toUpperCase();
        const found = topology.elements.some((el: any) => el.label.toUpperCase() === upper);
        if (!found) {
          const labels = topology.elements.map((el: any) => el.label as string);
          const suggestions = suggestComponents(label, labels);
          throw new Error(
            `harness_query: component "${label}" not found. Did you mean: ${suggestions.join(", ")}?`,
          );
        }
        return upper;
      }

      // Helper: paginate array
      function paginate<T>(items: T[], defaultLimit: number): { items: T[]; total: number } {
        const total = items.length;
        const lim = args.limit ?? defaultLimit;
        return { items: items.slice(offset, offset + lim), total };
      }

      // Helper: apply step/time range filters to steps array
      function filterStepIndices(indices: number[]): number[] {
        let result = indices;
        if (args.stepRange) {
          const [from, to] = args.stepRange;
          result = result.filter((i) => i >= from && i <= to);
        }
        if (args.timeRange && (session as any)._ourSession) {
          const [tFrom, tTo] = args.timeRange;
          result = result.filter((i) => {
            const t = (session as any)._ourSession.steps[i]?.simTime ?? 0;
            return t >= tFrom && t <= tTo;
          });
        }
        return result;
      }

      // -----------------------------------------------------------------------
      // Priority dispatch
      // -----------------------------------------------------------------------

      // P1: type === "summary"
      if (args.type === "summary") {
        const summary = session.getSummary();
        return JSON.stringify({
          handle: args.handle,
          queryMode: "summary",
          total: 1,
          offset: 0,
          limit: 1,
          summary: serializeSummary(summary),
        });
      }

      // P2: component + step + iteration + limiting
      if (args.component !== undefined && args.step !== undefined && args.iteration !== undefined && args.limiting) {
        const label = requireComponent(args.component);
        const report = session.getLimitingComparison(label, args.step, args.iteration);
        const limitingData = {
          component: report.label,
          stepIndex: args.step,
          iteration: args.iteration,
          junctions: report.junctions.map((j: any) => ({
            junction: j.junction,
            ourPreLimit: formatNumber(j.ourPreLimit),
            ourPostLimit: formatNumber(j.ourPostLimit),
            ourDelta: formatNumber(j.ourDelta),
            ngspicePreLimit: formatNumber(j.ngspicePreLimit),
            ngspicePostLimit: formatNumber(j.ngspicePostLimit),
            ngspiceDelta: formatNumber(j.ngspiceDelta),
            limitingDiff: formatNumber(j.limitingDiff),
          })),
          noEvents: report.noEvents,
        };
        return JSON.stringify({
          handle: args.handle,
          queryMode: "limiting",
          total: report.junctions.length,
          offset,
          limit: args.limit ?? 100,
          limitingData,
        });
      }

      // P3: component + step + iteration + convergence
      if (args.component !== undefined && args.step !== undefined && args.iteration !== undefined && args.convergence) {
        const label = requireComponent(args.component);
        const detail = session.getConvergenceDetail(args.step, args.iteration);
        const filtered = detail.elements.filter((e: any) => e.label.toUpperCase() === label);
        const { items, total } = paginate(filtered, 100);
        const convergenceData = items.map((e: any) => ({
          label: e.label,
          deviceType: e.deviceType,
          ourConverged: e.ourConverged,
          ngspiceConverged: e.ngspiceConverged,
          converged: e.ourConverged,
          noncon: e.ourConverged ? 0 : 1,
          worstDelta: e.worstDelta !== undefined ? formatNumber(e.worstDelta) : undefined,
          agree: e.agree,
        }));
        return JSON.stringify({
          handle: args.handle,
          queryMode: "per-element-convergence",
          total,
          offset,
          limit: args.limit ?? 100,
          convergenceData,
        });
      }

      // P4: step + iteration + convergence (all elements)
      if (args.step !== undefined && args.iteration !== undefined && args.convergence) {
        const detail = session.getConvergenceDetail(args.step, args.iteration);
        const { items, total } = paginate(detail.elements, 100);
        const convergenceData = items.map((e: any) => ({
          label: e.label,
          deviceType: e.deviceType,
          ourConverged: e.ourConverged,
          ngspiceConverged: e.ngspiceConverged,
          converged: e.ourConverged,
          noncon: e.ourConverged ? 0 : 1,
          worstDelta: e.worstDelta !== undefined ? formatNumber(e.worstDelta) : undefined,
          agree: e.agree,
        }));
        return JSON.stringify({
          handle: args.handle,
          queryMode: "per-element-convergence",
          total,
          offset,
          limit: args.limit ?? 100,
          convergenceData,
        });
      }

      // P5: component + step + stateHistory
      if (args.component !== undefined && args.step !== undefined && args.stateHistory) {
        const label = requireComponent(args.component);
        const report = session.getStateHistory(label, args.step);
        // getStateHistory returns a snapshot at a single iteration; reformat as iterations array
        const slots = Object.keys(report.state0);
        const filteredSlots = args.slots
          ? slots.filter((s) => args.slots!.some((pat) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i").test(s)))
          : slots;
        const iterations = [{
          iteration: report.iteration,
          states: Object.fromEntries(
            filteredSlots.map((slot) => [
              slot,
              formatComparedValue({
                ours: report.state0[slot] ?? NaN,
                ngspice: report.ngspiceState0[slot] ?? NaN,
                delta: (report.state0[slot] ?? NaN) - (report.ngspiceState0[slot] ?? NaN),
                absDelta: Math.abs((report.state0[slot] ?? NaN) - (report.ngspiceState0[slot] ?? NaN)),
                relDelta: NaN,
                withinTol: false,
              }),
            ]),
          ),
        }];
        const { items, total } = paginate(iterations, 100);
        return JSON.stringify({
          handle: args.handle,
          queryMode: "step-state-history",
          total,
          offset,
          limit: args.limit ?? 100,
          stateHistory: {
            component: label,
            stepIndex: args.step,
            simTime: formatNumber(report.stepIndex >= 0 ? (session as any)._ourSession?.steps[args.step]?.simTime ?? 0 : 0),
            slots: filteredSlots,
            iterations: items,
          },
        });
      }

      // P6: step + integrationCoefficients
      if (args.step !== undefined && args.integrationCoefficients) {
        const report = session.getIntegrationCoefficients(args.step);
        const integrationCoefficients = {
          stepIndex: report.stepIndex,
          ours: {
            ag0: formatNumber(report.ours.ag0),
            ag1: formatNumber(report.ours.ag1),
            method: report.ours.method,
            order: report.ours.order,
          },
          ngspice: {
            ag0: formatNumber(report.ngspice.ag0),
            ag1: formatNumber(report.ngspice.ag1),
            method: report.ngspice.method,
            order: report.ngspice.order,
          },
          cktMode: (session as any)._ourSession?.steps[args.step]?.cktMode ?? 0,
          ag0Compared: formatComparedValue(report.ag0Compared),
          ag1Compared: formatComparedValue(report.ag1Compared),
          methodMatch: report.methodMatch,
        };
        return JSON.stringify({
          handle: args.handle,
          queryMode: "integration-coefficients",
          total: 1,
          offset,
          limit: 1,
          integrationCoefficients,
        });
      }

      // P7: step + iterations
      if (args.step !== undefined && args.iterations) {
        const iterReports = session.getIterations(args.step);
        const rawOurStep = (session as any)._ourSession?.steps[args.step];
        const ourTopology = (session as any)._ourTopology;
        const { items, total } = paginate(iterReports, 100);
        const iterationData = items.map((r: any) => {
          const rawIter = rawOurStep?.iterations[r.iteration];
          const prevNodes: Record<string, any> = {};
          if (rawIter?.prevVoltages && ourTopology?.nodeLabels) {
            (ourTopology.nodeLabels as Map<number, string>).forEach((label, nodeId) => {
              if (nodeId > 0 && nodeId - 1 < rawIter.prevVoltages.length) {
                prevNodes[label] = formatNumber(rawIter.prevVoltages[nodeId - 1]);
              }
            });
          }
          return {
          stepIndex: r.stepIndex,
          iteration: r.iteration,
          simTime: formatNumber(r.simTime),
          noncon: formatComparedValue(r.noncon),
          nodes: Object.fromEntries(
            Object.entries(r.nodes).map(([k, v]) => [k, formatComparedValue(v as any)]),
          ),
          prevNodes,
          rhs: Object.fromEntries(
            Object.entries(r.rhs).map(([k, v]) => [k, formatComparedValue(v as any)]),
          ),
          matrixDiffs: (r.matrixDiffs ?? []).map((md: any) => ({
            rowLabel: md.rowLabel ?? String(md.row),
            colLabel: md.colLabel ?? String(md.col),
            ours: formatNumber(md.ours),
            ngspice: formatNumber(md.ngspice),
            absDelta: formatNumber(md.absDelta),
          })),
          components: Object.fromEntries(
            Object.entries(r.components).map(([comp, slots]) => [
              comp,
              Object.fromEntries(
                Object.entries(slots as Record<string, any>).map(([slot, cv]) => [slot, formatComparedValue(cv)]),
              ),
            ]),
          ),
          };
        });
        return JSON.stringify({
          handle: args.handle,
          queryMode: "step-iterations",
          total,
          offset,
          limit: args.limit ?? 100,
          iterationData,
        });
      }

      // P8: component + step (no modifiers)
      if (args.component !== undefined && args.step !== undefined) {
        const label = requireComponent(args.component);
        const stepEnd = session.getStepEnd(args.step);
        const compEntry = stepEnd.components[label] ?? stepEnd.components[label.toUpperCase()];
        const rawSlots = compEntry ? Object.entries(compEntry.slots) : [];
        let filteredSlots = rawSlots;
        if (args.filter === "divergences") {
          filteredSlots = rawSlots.filter(([, cv]) => !(cv as any).withinTol);
        }
        const { items, total } = paginate(filteredSlots, 50);
        return JSON.stringify({
          handle: args.handle,
          queryMode: "component-step-end",
          total,
          offset,
          limit: args.limit ?? 50,
          stepEnd: {
            stepIndex: args.step,
            label,
            deviceType: compEntry?.deviceType ?? "unknown",
            slots: Object.fromEntries(items.map(([k, v]) => [k, formatComparedValue(v as any)])),
          },
        });
      }

      // P9: component + filter: "divergences"
      if (args.component !== undefined && args.filter === "divergences") {
        const label = requireComponent(args.component);
        const divergenceReport = session.getDivergences({ component: label });
        const validEntries9 = divergenceReport.entries.filter((e: any) => Number.isFinite(e.absDelta) && e.absDelta > 0);
        const { items, total } = paginate(validEntries9, 100);
        const divergences = items.map((e: any) => ({
          stepIndex: e.stepIndex,
          iterationIndex: e.iteration,
          stepStartTime: formatNumber(e.stepStartTime),
          type: e.category as "node" | "rhs" | "matrix" | "state",
          label: e.label,
          ours: formatNumber(e.ours),
          ngspice: formatNumber(e.ngspice),
          absDelta: formatNumber(e.absDelta),
          relDelta: formatNumber(e.relDelta),
        }));
        return JSON.stringify({
          handle: args.handle,
          queryMode: "component-divergences",
          total,
          offset,
          limit: args.limit ?? 100,
          divergences,
        });
      }

      // P10: component only (trace)
      if (args.component !== undefined) {
        const label = requireComponent(args.component);
        const traceOpts: any = { offset, limit: args.limit ?? 50 };
        if (args.slots) traceOpts.slots = args.slots;
        if (args.stepRange) traceOpts.stepsRange = { from: args.stepRange[0], to: args.stepRange[1] };
        const trace = session.traceComponent(label, traceOpts);
        const total = trace.steps.length;
        const componentTrace = {
          label: trace.label,
          deviceType: trace.deviceType,
          steps: trace.steps.map((s: any) => ({
            stepIndex: s.stepIndex,
            simTime: formatNumber(s.simTime),
            iterations: s.iterations.map((it: any) => ({
              iteration: it.iteration,
              states: Object.fromEntries(
                Object.entries(it.states).map(([k, v]) => [k, formatComparedValue(v as any)]),
              ),
              pinVoltages: Object.fromEntries(
                Object.entries(it.pinVoltages).map(([k, v]) => [k, formatComparedValue(v as any)]),
              ),
            })),
          })),
        };
        return JSON.stringify({
          handle: args.handle,
          queryMode: "component-trace",
          total,
          offset,
          limit: args.limit ?? 50,
          componentTrace,
        });
      }

      // P11: node
      if (args.node !== undefined) {
        const upper = args.node.toUpperCase();
        let found = false;
        topology.nodeLabels.forEach((label: string) => {
          if (label.toUpperCase() === upper) found = true;
        });
        if (!found) {
          const knownNodes: string[] = [];
          topology.nodeLabels.forEach((label: string) => knownNodes.push(label));
          throw new Error(
            `harness_query: node "${args.node}" not found. Known nodes (first 10): ${knownNodes.slice(0, 10).join(", ")}.`,
          );
        }
        const traceOpts: any = { offset, limit: args.limit ?? 50 };
        if (args.stepRange) traceOpts.stepsRange = { from: args.stepRange[0], to: args.stepRange[1] };
        const trace = session.traceNode(upper, traceOpts);
        const total = trace.steps.length;
        const nodeTrace = {
          label: trace.label,
          ourIndex: trace.ourIndex,
          ngspiceIndex: trace.ngspiceIndex,
          steps: trace.steps.map((s: any) => ({
            stepIndex: s.stepIndex,
            simTime: formatNumber(s.simTime),
            iterations: s.iterations.map((it: any) => ({
              iteration: it.iteration,
              voltage: formatComparedValue(it.voltage),
            })),
          })),
        };
        return JSON.stringify({
          handle: args.handle,
          queryMode: "node-trace",
          total,
          offset,
          limit: args.limit ?? 50,
          nodeTrace,
        });
      }

      // P12: step only (step-end)
      if (args.step !== undefined) {
        const stepEnd = session.getStepEnd(args.step);
        let nodeEntries = Object.entries(stepEnd.nodes);
        let branchEntries = Object.entries(stepEnd.branches ?? {});
        if (args.filter === "divergences") {
          nodeEntries = nodeEntries.filter(([, cv]) => !(cv as any).withinTol);
          branchEntries = branchEntries.filter(([, cv]) => !(cv as any).withinTol);
        }
        return JSON.stringify({
          handle: args.handle,
          queryMode: "step-end",
          total: nodeEntries.length + branchEntries.length,
          offset,
          limit: args.limit ?? 100,
          stepEnd: {
            stepIndex: stepEnd.stepIndex,
            stepStartTime: formatComparedValue(stepEnd.stepStartTime),
            stepEndTime: formatComparedValue(stepEnd.stepEndTime),
            dt: formatComparedValue(stepEnd.dt),
            converged: stepEnd.converged,
            iterationCount: formatComparedValue(stepEnd.iterationCount),
            nodes: Object.fromEntries(nodeEntries.map(([k, v]) => [k, formatComparedValue(v as any)])),
            branches: Object.fromEntries(branchEntries.map(([k, v]) => [k, formatComparedValue(v as any)])),
            components: Object.fromEntries(
              Object.entries(stepEnd.components).map(([comp, entry]) => [
                comp,
                Object.fromEntries(
                  Object.entries((entry as any).slots).map(([slot, cv]) => [slot, formatComparedValue(cv as any)]),
                ),
              ]),
            ),
          },
        });
      }

      // P13: deviceType
      if (args.deviceType !== undefined) {
        const matching = session.getComponentsByType(args.deviceType);
        if (matching.length === 0) {
          const availableTypes = [...new Set(topology.elements.map((el: any) => el.type ?? "unknown"))];
          throw new Error(
            `harness_query: no components of type "${args.deviceType}". Types present: ${availableTypes.join(", ")}.`,
          );
        }
        const allStepIndices = Array.from({ length: totalSteps }, (_, i) => i);
        const filteredIndices = filterStepIndices(allStepIndices);
        const { items: stepSlice, total } = paginate(filteredIndices, 50);
        const steps = stepSlice.map((si: number) => {
          const stepEnd = session.getStepEnd(si);
          const ourStep = (session as any)._ourSession?.steps[si];
          const comps: Record<string, Record<string, any>> = {};
          for (const comp of matching) {
            const label = comp.label;
            const upper = label.toUpperCase();
            const compEntry = stepEnd.components[upper] ?? stepEnd.components[label];
            if (compEntry) {
              comps[label] = Object.fromEntries(
                Object.entries(compEntry.slots).map(([slot, cv]) => [slot, formatComparedValue(cv as any)]),
              );
            }
          }
          return {
            stepIndex: si,
            simTime: formatNumber(ourStep?.simTime ?? 0),
            components: comps,
          };
        });
        return JSON.stringify({
          handle: args.handle,
          queryMode: "device-type",
          total,
          offset,
          limit: args.limit ?? 50,
          deviceTypeData: {
            deviceType: args.deviceType,
            components: matching,
            steps,
          },
        });
      }

      // P14: filter: "divergences" or "worst" (no component)
      if (args.filter === "divergences" || args.filter === "worst") {
        const divergenceReport = session.getDivergences();
        let entries: any[] = divergenceReport.entries.filter((e: any) => Number.isFinite(e.absDelta) && e.absDelta > 0);
        if (args.filter === "worst") {
          const n = args.worstN ?? 10;
          entries = entries.slice().sort((a: any, b: any) => b.absDelta - a.absDelta).slice(0, n);
        }
        const { items, total } = paginate(entries, 100);
        const divergences = items.map((e: any) => ({
          stepIndex: e.stepIndex,
          iterationIndex: e.iteration,
          stepStartTime: formatNumber(e.stepStartTime),
          type: e.category as "node" | "rhs" | "matrix" | "state",
          label: e.label,
          ours: formatNumber(e.ours),
          ngspice: formatNumber(e.ngspice),
          absDelta: formatNumber(e.absDelta),
          relDelta: formatNumber(e.relDelta),
        }));
        return JSON.stringify({
          handle: args.handle,
          queryMode: "divergences",
          total,
          offset,
          limit: args.limit ?? 100,
          divergences,
        });
      }

      // P15: no primary mode
      throw new Error(
        `harness_query: no query mode selected. Provide: component, node, step, deviceType, or type.`,
      );
    }),
  );

  // -------------------------------------------------------------------------
  // harness_compare_matrix
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_compare_matrix",
    {
      title: "Compare MNA Matrix",
      description:
        "Return a labeled comparison of MNA matrix entries for a specific step and NR iteration. " +
        "Each entry contains the row and column labels and both engine values. " +
        "Supports filtering to mismatches only.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
        step: z.number().int().min(0).describe("Step index"),
        iteration: z.number().int().min(0).describe("NR iteration index within the step"),
        filter: z.enum(["all", "mismatches"]).optional().describe(
          "'all' returns every captured matrix entry. " +
          "'mismatches' returns only entries where |ours - ngspice| exceeds tolerance. Default: 'mismatches'.",
        ),
        offset: z.number().int().min(0).optional().describe("Pagination offset. Default: 0."),
        limit: z.number().int().min(1).optional().describe("Maximum entries to return. Default: 100."),
      }),
    },
    wrapTool("harness_compare_matrix", async (args) => {
      const entry = harnessState.get(args.handle, "harness_compare_matrix");
      const { session } = entry;

      if (!entry.analysis) {
        throw new Error(`harness_compare_matrix: run harness_run first`);
      }

      const totalSteps: number = (session as any)._ourSession?.steps?.length ?? 0;
      if (args.step >= totalSteps) {
        throw new Error(
          `harness_compare_matrix: step ${args.step} out of range [0, ${totalSteps - 1}]. Run has ${totalSteps} steps.`,
        );
      }

      const stepIterations: number = (session as any)._ourSession?.steps[args.step]?.iterations?.length ?? 0;
      if (args.iteration >= stepIterations) {
        throw new Error(
          `harness_compare_matrix: iteration ${args.iteration} out of range [0, ${stepIterations - 1}] at step ${args.step}`,
        );
      }

      const filter = args.filter ?? "mismatches";
      const comparison = session.compareMatrixAt(args.step, args.iteration, filter);

      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const total = comparison.entries.length;
      const pageEntries = comparison.entries.slice(offset, offset + limit);

      const entries = pageEntries.map((e: any) => ({
        rowLabel: e.rowLabel,
        colLabel: e.colLabel,
        rowIndex: e.row,
        colIndex: e.col,
        ours: formatNumber(e.ours),
        ngspice: formatNumber(e.ngspice),
        delta: formatNumber(e.ours - e.ngspice),
        absDelta: formatNumber(e.absDelta),
        withinTol: e.withinTol,
      }));

      return JSON.stringify({
        handle: args.handle,
        step: args.step,
        iteration: args.iteration,
        filter,
        total,
        offset,
        limit,
        entries,
      });
    }),
  );

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
