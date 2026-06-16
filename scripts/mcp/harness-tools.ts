// harness-tools.ts- MCP tool registration for ngspice comparison harness

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wrapTool } from "./tool-helpers.js";
import { HarnessSessionState } from "./harness-session-state.js";
import { ComparisonSession } from "../../src/solver/analog/__tests__/harness/comparison-session.js";
import { resolveNgspiceDllPath } from "../../src/solver/analog/__tests__/harness/ngspice-dll-path.js";
import { formatNumber, formatComparedValue, suggestComponents } from "./harness-format.js";
import { writeFileSync } from "fs";
import type { SessionSummary, NRPhase, AcSessionShape } from "../../src/solver/analog/__tests__/harness/types.js";
import { resolveSlice, applySliceToIteration } from "../../src/solver/analog/__tests__/harness/slice.js";
import type { SliceFilter } from "../../src/solver/analog/__tests__/harness/slice.js";
import { isPoolBacked } from "../../src/solver/analog/element.js";

// ---------------------------------------------------------------------------
// JSON serialization helpers
// ---------------------------------------------------------------------------

/**
 * Read the OPTIONAL `circuit.nodesets` / `circuit.ics` objects from a `.dts`
 * JSON file and convert each to a `ReadonlyMap<string, number>` keyed by
 * net/pin NAME (e.g. `{"Q1:C":5}` -> Map([["Q1:C",5]])). Absent or empty
 * fields read as undefined, so `harness_start({dtsPath})` alone self-contains
 * any `.nodeset` / `.ic` stimulus the loop's gate prompt needs without extra
 * args. A malformed (non-object / non-numeric-value) field is rejected rather
 * than silently dropped, so a typo can never quietly defeat the gate.
 */
function readDtsConstraints(dtsPath: string): {
  nodesets?: ReadonlyMap<string, number>;
  ics?: ReadonlyMap<string, number>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(dtsPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `harness_start: failed to parse .dts JSON at ${dtsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const circuit = (parsed as { circuit?: unknown }).circuit;
  const toMap = (
    field: unknown,
    fieldName: string,
  ): ReadonlyMap<string, number> | undefined => {
    if (field === undefined || field === null) return undefined;
    if (typeof field !== "object" || Array.isArray(field)) {
      throw new Error(
        `harness_start: circuit.${fieldName} must be a JSON object mapping ` +
          `net/pin NAME -> volts (e.g. {"Q1:C":5}).`,
      );
    }
    const entries = Object.entries(field as Record<string, unknown>);
    if (entries.length === 0) return undefined;
    const map = new Map<string, number>();
    for (const [name, value] of entries) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `harness_start: circuit.${fieldName}["${name}"] must be a finite number (volts).`,
        );
      }
      map.set(name, value);
    }
    return map;
  };
  if (typeof circuit !== "object" || circuit === null) {
    return {};
  }
  const c = circuit as { nodesets?: unknown; ics?: unknown };
  return {
    nodesets: toMap(c.nodesets, "nodesets"),
    ics: toMap(c.ics, "ics"),
  };
}

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
        worstStep: summary.convergence.ours.worstStep,
      },
      ngspice: {
        totalSteps: summary.convergence.ngspice.totalSteps,
        convergedSteps: summary.convergence.ngspice.convergedSteps,
        failedSteps: summary.convergence.ngspice.failedSteps,
        avgIterations: formatNumber(summary.convergence.ngspice.avgIterations),
        maxIterations: summary.convergence.ngspice.maxIterations,
        worstStep: summary.convergence.ngspice.worstStep,
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

/**
 * Compact frequency-axis-parity summary for an AC sweep, parallel to
 * `serializeSummary` for DC/TRAN. Carries the point counts, presence breakdown,
 * and the reported-not-gated `largeFreqDeltas`; the full per-point detail and
 * per-class divergence live in `harness_first_divergence` (AC branch).
 */
function serializeAcShape(shape: AcSessionShape) {
  return {
    pointCount: shape.pointCount,
    presenceCounts: shape.presenceCounts,
    largeFreqDeltas: shape.largeFreqDeltas,
  };
}

/**
 * Guard the DC/TRAN-only investigation tools against an AC session. AC captures
 * per-frequency complex points, not the per-step / per-attempt NR structure
 * these tools read, so calling them on an AC handle would dereference the absent
 * DC/TRAN capture. AC investigation goes through harness_first_divergence (which
 * dispatches to the AC classes) and the harness_run_ac shape.
 */
function assertDcTranSession(analysis: string | null, tool: string): void {
  if (analysis === "ac") {
    throw new Error(
      `${tool}: not available for AC sessions. Use harness_first_divergence ` +
        `(AC branch: solution / shape / matrix / rhs) and the harness_run_ac shape; ` +
        `the per-step, per-attempt, matrix-diff, and export surfaces are DC/TRAN-only.`,
    );
  }
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
            "Absolute path to the ngspice shared library (ngspice.dll / libngspice.so). " +
              "Defaults to NGSPICE_DLL_PATH env var, then the in-tree build location.",
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

      // Resolve the DLL path under the single-source precedence (explicit
      // dllPath override → NGSPICE_DLL_PATH → in-tree default) and validate it
      // exists, so ComparisonSession does not re-resolve a different path.
      const dllPath = resolveNgspiceDllPath(args.dllPath);
      if (!existsSync(dllPath)) {
        throw new Error(
          `harness_start: ngspice DLL not found: ${dllPath}. Set NGSPICE_DLL_PATH or pass dllPath.`,
        );
      }

      // Self-contain any `.nodeset` / `.ic` stimulus carried in the .dts itself
      // (optional `circuit.nodesets` / `circuit.ics` objects). Absent fields →
      // undefined → unchanged behaviour. This keeps the loop's gate prompt
      // uniform: harness_start({dtsPath}) alone drives the constrained run.
      const { nodesets, ics } = readDtsConstraints(dtsPath);

      const session = new ComparisonSession({
        dtsPath: args.dtsPath,
        dllPath,
        tolerance: args.tolerance,
        maxOurSteps: args.maxOurSteps,
        nodesets,
        ics,
        // Structural-parity asserts throw inside runDcOp/runTransient, which
        // makes coord-set / matrix-size divergences fatal at the MCP layer
        // — exactly the bugs the investigation tools below need to surface.
        // Defer so harness_run never short-circuits; agents read the verdict
        // through harness_topology_diff / harness_matrix_diff / structuralFindings.
        deferStructuralAsserts: true,
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
      const topology = session.ourTopology;
      const engine = session.engine;

      const components = topology.elements.map((el: any) => {
        const engineEl = (engine?.elements ?? [])[el.index];
        const slots: string[] =
          engineEl && isPoolBacked(engineEl)
            ? engineEl.stateSchema.slots.map((s: any) => s.name)
            : [];
        const elPinIds: number[] = engineEl
          ? [...engineEl.pinNodes.values()]
          : [];
        const pins: string[] = elPinIds.map((nodeId: number) => {
          if (nodeId === 0) return "gnd";
          return topology.nodeLabels.get(nodeId) ?? `node${nodeId}`;
        });
        return {
          label: el.label,
          type: el.type ?? "unknown",
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
          const engineEl = (engine?.elements ?? [])[el.index];
          const elPinIds: number[] = engineEl
            ? [...engineEl.pinNodes.values()]
            : [];
          if (elPinIds.includes(nodeId)) {
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
        // z.preprocess coerces a JSON-string-encoded array (some MCP clients
        // serialize nested array args as strings) into a real array before the
        // array schema validates; a genuine array passes through untouched.
        hotloads: z
          .preprocess(
            (v) => {
              if (typeof v !== "string") return v;
              try {
                return JSON.parse(v);
              } catch {
                return v; // let the array schema report the type error
              }
            },
            z
              .array(
                z.object({
                  atTime: z.number().min(0).describe("Sim time (s) at/after which to apply the hot-load."),
                  ourLabel: z.string().describe("digiTS component label (setComponentProperty target)."),
                  ngDevice: z.string().describe("ngspice deck device/model name (alter/altermod target)."),
                  param: z.string().describe("Parameter name (shared by both sides)."),
                  value: z.number().describe("New parameter value."),
                  isModel: z
                    .boolean()
                    .describe("true → ngspice altermod (model param); false → alter (instance param)."),
                }),
              )
              .optional(),
          )
          .describe(
            "Mid-transient parameter hot-loads applied to BOTH engines (digiTS setComponentProperty + " +
              "ngspice alter/altermod + resume), to reproduce a live param change and compare per-step. " +
              "Parity holds for primitives with a 1:1 ngspice device; behavioural composites (e.g. Schmitt) " +
              "have no ngspice equivalent and run digiTS-only.",
          ),
      }),
    },
    wrapTool("harness_run", async (args) => {
      const entry = harnessState.get(args.handle, "harness_run");

      const { session } = entry;

      const startTime = args.startTime ?? 0;
      const stopTime = args.stopTime ?? 1e-5;
      await session.runTransient(startTime, stopTime, args.maxStep, args.hotloads);

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
  // harness_run_dcop
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_run_dcop",
    {
      title: "Run DC Operating Point Analysis",
      description:
        "Run a standalone DC operating-point comparison on both engines (ours + " +
        "ngspice). A session runs one analysis kind- call this OR harness_run " +
        "(transient) OR harness_run_ac, not more than one, on the same handle; start " +
        "a fresh session to switch. After this, harness_first_divergence reports the " +
        "DC-OP voltage/matrix/state/shape divergence. " +
        "Pass `optran` to enable the OPtran pseudo-transient operating-point fallback " +
        "(ngspice optran.c / cktop.c:101-108): the digiTS engine is configured with " +
        "optran/opstepsize/opfinaltime/opramptime and the ngspice side issues " +
        "`optran 1 1 1 <step> <final> <ramp>` before `op`, so a circuit that exhausts " +
        "direct NR + gmin stepping + source stepping (e.g. an inductor-induced DC " +
        "branch-current singularity) settles via the pseudo-transient on both sides.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
        optran: z
          .object({
            opstepsize: z
              .number()
              .positive()
              .describe("OPtran pseudo-transient step size in seconds (ngspice opstepsize)."),
            opfinaltime: z
              .number()
              .positive()
              .describe("OPtran pseudo-transient final time in seconds (ngspice opfinaltime)."),
            opramptime: z
              .number()
              .min(0)
              .optional()
              .describe(
                "OPtran supply-ramp time in seconds (ngspice opramptime). 0 (default) " +
                  "runs sources at full value; >0 eases supplies in via a raised cosine.",
              ),
          })
          .optional()
          .describe(
            "Enable the OPtran operating-point pseudo-transient fallback. Omit for the " +
              "default DC-OP path (direct NR + gmin + source stepping only).",
          ),
      }),
    },
    wrapTool("harness_run_dcop", async (args) => {
      const entry = harnessState.get(args.handle, "harness_run_dcop");
      const { session } = entry;

      await session.runDcOp(args.optran);

      entry.lastRunAt = new Date();
      entry.analysis = "dcop";

      const summary = session.getSummary();

      return JSON.stringify({
        handle: args.handle,
        analysis: "dcop",
        summary: serializeSummary(summary),
        errors: session.errors,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_run_ac
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_run_ac",
    {
      title: "Run AC Sweep",
      description:
        "Run a small-signal AC frequency sweep on both engines (ours + ngspice). " +
        "A session runs one analysis kind- call this OR harness_run (transient), not " +
        "both, on the same handle; start a fresh session to switch. After this, " +
        "harness_first_divergence dispatches to the AC classes (solution / shape / " +
        "matrix / rhs). The response is the frequency-axis-parity shape; per-class " +
        "divergence comes from harness_first_divergence.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
        type: z
          .enum(["lin", "dec", "oct"])
          .optional()
          .describe("Sweep spacing: linear, per-decade, or per-octave. Default: dec."),
        numPoints: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Points per decade/octave ('dec'/'oct') or total points ('lin'). Default: 10.",
          ),
        fStart: z.number().positive().optional().describe("Start frequency in Hz. Default: 1."),
        fStop: z.number().positive().optional().describe("Stop frequency in Hz. Default: 1e6."),
        outputNodes: z
          .array(z.string())
          .optional()
          .describe(
            "Optional node labels to measure (e.g. 'out', 'V1:pos'). The harness compares " +
              "the full complex solution vector regardless; default [].",
          ),
      }),
    },
    wrapTool("harness_run_ac", async (args) => {
      const entry = harnessState.get(args.handle, "harness_run_ac");
      const { session } = entry;

      await session.runAcSweep({
        type: args.type ?? "dec",
        numPoints: args.numPoints ?? 10,
        fStart: args.fStart ?? 1,
        fStop: args.fStop ?? 1e6,
        outputNodes: args.outputNodes ?? [],
      });

      entry.lastRunAt = new Date();
      entry.analysis = "ac";

      return JSON.stringify({
        handle: args.handle,
        analysis: "ac",
        shape: serializeAcShape(session.getAcSessionShape()),
        errors: session.errors,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_ac_session_shape
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_ac_session_shape",
    {
      title: "AC Session Shape (per-frequency-point)",
      description:
        "Return the full frequency-axis-parity shape for an AC session (after " +
        "harness_run_ac): per-point presence, freq, omega, and matrixSize for each " +
        "side, plus pointCount, presenceCounts, and the reported-not-gated " +
        "largeFreqDeltas. This is the AC analog of harness_session_map- the " +
        "structural surface to consult before drilling per-class divergence with " +
        "harness_first_divergence (AC branch). A non-empty largeFreqDeltas means " +
        "the two sides swept different frequencies and downstream complex compares " +
        "are measuring noise.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
      }),
    },
    wrapTool("harness_ac_session_shape", async (args) => {
      const entry = harnessState.get(args.handle, "harness_ac_session_shape");
      if (entry.analysis !== "ac") {
        throw new Error(
          `harness_ac_session_shape: requires an AC session- run harness_run_ac first ` +
            `(current analysis is ${entry.analysis ?? "none"}).`,
        );
      }
      return JSON.stringify({
        handle: args.handle,
        analysis: "ac",
        shape: entry.session.getAcSessionShape(),
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
        "Return full circuit topology metadata for the session- components with " +
        "their pin assignments and slot names, and nodes with connectivity. Does not " +
        "require harness_run to be called first.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
      }),
    },
    wrapTool("harness_describe", async (args) => {
      const entry = harnessState.get(args.handle, "harness_describe");
      const { session } = entry;

      const topology = session.ourTopology;
      const engine = session.engine;
      const nodeMap = session.nodeMap;

      // Build a flat descriptor for each element, then group internalOnly
      // sub-elements (identified by the <parentLabel>:<subElementName> label
      // convention stamped by compiler.ts setLabel) under their parent composite.
      const flatDescs = topology.elements.map((el: any) => {
        const engineEl = (engine?.elements ?? [])[el.index];
        const slots: string[] =
          engineEl && isPoolBacked(engineEl)
            ? engineEl.stateSchema.slots.map((s: any) => s.name)
            : [];
        const elPinIds: number[] = engineEl
          ? [...engineEl.pinNodes.values()]
          : [];
        const pins = elPinIds.map((nodeId: number) => ({
          label:
            nodeId === 0
              ? "gnd"
              : topology.nodeLabels.get(nodeId) ?? `node${nodeId}`,
          nodeIndex: nodeId,
        }));
        const colonIdx = el.label.indexOf(":");
        const parentLabel = colonIdx !== -1 ? el.label.slice(0, colonIdx) : null;
        const subElementName = colonIdx !== -1 ? el.label.slice(colonIdx + 1) : null;
        return {
          label: el.label,
          index: el.index,
          type: el.type ?? "unknown",
          pins,
          slots,
          parentLabel,
          subElementName,
        };
      });

      // Separate top-level components from sub-elements.
      const topLevelMap = new Map<string, any>();
      const subElementsByParent = new Map<string, any[]>();

      for (const desc of flatDescs) {
        if (desc.parentLabel !== null) {
          let group = subElementsByParent.get(desc.parentLabel);
          if (!group) {
            group = [];
            subElementsByParent.set(desc.parentLabel, group);
          }
          group.push({
            label: desc.label,
            subElementName: desc.subElementName,
            index: desc.index,
            type: desc.type,
            pins: desc.pins,
            slots: desc.slots,
          });
        } else {
          topLevelMap.set(desc.label, {
            label: desc.label,
            index: desc.index,
            type: desc.type,
            pins: desc.pins,
            slots: desc.slots,
          });
        }
      }

      // Attach sub-elements to their parent composite entries.
      for (const [parentLabel, subs] of subElementsByParent) {
        const parent = topLevelMap.get(parentLabel);
        if (parent) {
          parent.subElements = subs;
        } else {
          // Parent composite not found at top level; surface sub-elements
          // directly so no data is lost.
          for (const sub of subs) {
            topLevelMap.set(sub.label, sub);
          }
        }
      }

      const components = [...topLevelMap.values()];

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
          const engineEl = (engine?.elements ?? [])[el.index];
          const pinIds: number[] = engineEl
            ? [...engineEl.pinNodes.values()]
            : [];
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
        "and timing for both engines. Lightweight- no iteration data included. " +
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
      assertDcTranSession(entry.analysis, "harness_session_map");
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
          "Simulation time in seconds- finds the nearest step by stepEndTime. " +
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
      assertDcTranSession(entry.analysis, "harness_get_step");
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
      // Normalize NaN sentinels to -1 so the JSON contract stays type-stable
      // (`typeof === "number"`). NaN survives ComparisonSession but JSON.stringify
      // emits it as `null`, which would otherwise break consumers asserting
      // numeric attempt-end norms. Mirrors the divergenceNorm handling below.
      // Branch norm is NaN whenever the circuit has no branch rows
      // (matrixSize === nodeCount + 1)- common for purely resistive/passive
      // fixtures with no V-source or inductor elements.
      const normalizeAttempt = <T extends { endNodeNorm: number; endBranchNorm: number }>(
        a: T,
      ): T => ({
        ...a,
        endNodeNorm: Number.isNaN(a.endNodeNorm) ? -1 : a.endNodeNorm,
        endBranchNorm: Number.isNaN(a.endBranchNorm) ? -1 : a.endBranchNorm,
      });
      const formatted = {
        ...detail,
        stepStartTime: formatComparedValue(detail.stepStartTime),
        stepEndTime: formatComparedValue(detail.stepEndTime),
        dt: formatComparedValue(detail.dt),
        ours: detail.ours.map(normalizeAttempt),
        ngspice: detail.ngspice.map(normalizeAttempt),
        pairing: detail.pairing.map(p => ({
          ...p,
          divergenceNorm: Number.isNaN(p.divergenceNorm) ? -1 : p.divergenceNorm,
        })),
      };
      return JSON.stringify({ handle: args.handle, step: formatted });
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
        "Supports iteration range and pagination.\n\n" +
        "Slice filters (nodes / component) narrow the returned rhs, residual, and matrix to a " +
        "K-node subspace. Both filters may be combined- their index sets are unioned, deduplicated, " +
        "and sorted. Omit both to return the full matrix regardless of circuit size.\n\n" +
        "nodes: array of node names (string) or 1-based node ids (integer). String lookup is " +
        "case-insensitive; segment match (split by '/') is used when no exact match exists. " +
        "Prime nodes (e.g. 'Q1:B\\'') are included in the full label set and are matchable by name.\n\n" +
        "component: component label (case-insensitive). Resolves to the union of: non-ground pin " +
        "node ids, prime nodes whose label starts with '<component>:', and branch rows in " +
        "matrixRowLabels at index >= nodeCount whose label matches the component exactly or starts " +
        "with '<component>#' or '<component>:'.\n\n" +
        "When a slice is active the response shape is " +
        "{ handle, attempt, slice: { matrixIndices, labels, fullMatrixSize } }. " +
        "Without a slice: { handle, attempt }.\n\n" +
        "Each paired iteration carries, per side, the quantities harness_first_divergence " +
        "does NOT classify but that pinpoint a faulty derivation: nodeVoltagesBefore " +
        "(pre-solve guess / predictor), residual + residualInfinityNorm (A·v-b: solve-stage " +
        "sanity- nonzero on one side means that engine failed to solve its own system), and " +
        "pinCurrents (terminal currents projected from state slots). Drill here after " +
        "first_divergence points at a step/iteration.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle"),
        stepIndex: z.number().int().min(0).describe("Step index (0-based)"),
        phase: z.enum([
          "dcopInitJct", "dcopInitFloat",
          "dcopDirect", "dcopGminDynamic", "dcopGminSpice3", "dcopSrcSweep",
          "tranInit", "tranPredictor", "tranNR",
        ] as [NRPhase, ...NRPhase[]]).describe("NR phase name"),
        phaseAttemptIndex: z.number().int().min(0).describe(
          "0-based index within attempts of this phase (usually 0).",
        ),
        iterationRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional().describe(
          "Inclusive [from, to] iteration indices within the attempt.",
        ),
        offset: z.number().int().min(0).optional().describe("Pagination offset. Default: 0."),
        limit: z.number().int().min(1).optional().describe("Maximum iterations to return."),
        nodes: z.array(z.union([z.string(), z.number().int().min(1)])).optional().describe(
          "Node names or 1-based node ids to include in the matrix/rhs/residual slice.",
        ),
        component: z.string().optional().describe(
          "Component label whose pins, prime nodes, and branch rows are included in the slice.",
        ),
      }),
    },
    wrapTool("harness_get_attempt", async (args) => {
      const entry = harnessState.get(args.handle, "harness_get_attempt");
      if (!entry.analysis) {
        throw new Error("harness_get_attempt: run harness_run first");
      }
      assertDcTranSession(entry.analysis, "harness_get_attempt");
      const detail = entry.session.getAttempt({
        stepIndex: args.stepIndex,
        phase: args.phase as NRPhase,
        phaseAttemptIndex: args.phaseAttemptIndex,
        iterationRange: args.iterationRange as [number, number] | undefined,
        limit: args.limit,
        offset: args.offset,
      });

      // Normalize divergenceNorm: NaN → -1 so JSON round-trip preserves number type
      const normalizeIterations = (iters: any[]) =>
        iters.map((paired: any) => ({
          ...paired,
          divergenceNorm: Number.isNaN(paired.divergenceNorm) ? -1 : paired.divergenceNorm,
        }));

      const sliceFilter: SliceFilter = {};
      if (args.nodes) sliceFilter.nodes = args.nodes as ReadonlyArray<string | number>;
      if (args.component) sliceFilter.component = args.component;

      const sliceActive = sliceFilter.nodes !== undefined || sliceFilter.component !== undefined;

      if (!sliceActive) {
        const normalizedDetail = { ...detail, iterations: normalizeIterations(detail.iterations) };
        return JSON.stringify({ handle: args.handle, attempt: normalizedDetail });
      }

      const topology = entry.session.ourTopology;
      const resolved = resolveSlice(sliceFilter, topology);

      if (resolved.matrixIndices.length === 0) {
        throw new Error("harness_get_attempt: slice resolved to empty index set");
      }

      const fullMatrixSize: number = topology.matrixSize;

      // Apply slice to each paired iteration
      const slicedIterations = normalizeIterations(detail.iterations).map((paired: any) => ({
        ...paired,
        ours: paired.ours ? applySliceToIteration(paired.ours, resolved, fullMatrixSize) : null,
        ngspice: paired.ngspice ? applySliceToIteration(paired.ngspice, resolved, fullMatrixSize) : null,
      }));

      const slicedDetail = { ...detail, iterations: slicedIterations };

      return JSON.stringify({
        handle: args.handle,
        attempt: slicedDetail,
        slice: {
          matrixIndices: resolved.matrixIndices,
          labels: resolved.labels,
          fullMatrixSize,
        },
      });
    }),
  );

  // harness_query and harness_compare_matrix removed- replaced by harness_session_map / harness_get_step / harness_get_attempt

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
      assertDcTranSession(entry.analysis, "harness_export");

      const topology = session.ourTopology;
      const engine = session.engine;
      const summary = session.getSummary();

      // Build topology components (detailed)
      const components = topology.elements.map((el: any) => {
        const engineEl = (engine?.elements ?? [])[el.index];
        const slots: string[] =
          engineEl && isPoolBacked(engineEl)
            ? engineEl.stateSchema.slots.map((s: any) => s.name)
            : [];
        const elPinIds: number[] = engineEl
          ? [...engineEl.pinNodes.values()]
          : [];
        const pins = elPinIds.map((nodeId: number) => ({
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
          const engineEl = (engine?.elements ?? [])[el.index];
          const pinIds: number[] = engineEl
            ? [...engineEl.pinNodes.values()]
            : [];
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

  // -------------------------------------------------------------------------
  // harness_topology_diff
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_topology_diff",
    {
      title: "Topology Diff",
      description:
        "Compare element-and-node topology between our compiled circuit and the " +
        "ngspice deck. Returns: " +
        "(a) elementDiffs — components present on one side but not the other " +
        "(matched by lowercased label with SPICE-prefix canonicalisation); " +
        "(b) orderingDiffs — matched nodes/branches whose 1-based slot index " +
        "differs between sides (each entry is one element 'allocated in a " +
        "different order'); " +
        "(c) unmappedNgspiceNodes — ngspice nodes the node-mapping pass could " +
        "not resolve to one of our slots; " +
        "(d) structuralFindings — deferred messages from the structural-parity " +
        "asserts (matrix-size divergence, first-iter coord-set / value-permutation " +
        "/ value-only). " +
        "Does not require harness_run first, but ngspice-side fields are populated " +
        "only after a run.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
      }),
    },
    wrapTool("harness_topology_diff", async (args) => {
      const entry = harnessState.get(args.handle, "harness_topology_diff");
      const report = entry.session.topologyDiff();
      return JSON.stringify({ handle: args.handle, topologyDiff: report });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_matrix_diff
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_matrix_diff",
    {
      title: "Matrix Diff",
      description:
        "Compare the Jacobian matrix between our engine and ngspice at one " +
        "reference iteration AND scan the whole session to attribute each " +
        "divergent cell to the (step, iter) where it first diverged. Returns: " +
        "(a) classification — 'match' / 'value-only' / 'value-permutation' / " +
        "'coord-set-differs'; " +
        "(b) oursOnly — cells in our matrix but not ngspice's; " +
        "(c) ngspiceOnly — cells in ngspice's matrix but not ours; " +
        "(d) valueMismatches — cells in both with differing values, sorted by " +
        "absDelta desc; each carries firstDivergentStep / firstDivergentIteration " +
        "so callers see which step the cell first went off (and don't need to " +
        "scan every step manually). " +
        "Reference defaults to (step 0, iter 0) — the same site the structural " +
        "assertions classify.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
        stepIndex: z.number().int().min(0).optional().describe(
          "Reference step index. Default: 0.",
        ),
        iterationIndex: z.number().int().min(0).optional().describe(
          "Reference iteration index within the accepted attempt. Default: 0.",
        ),
      }),
    },
    wrapTool("harness_matrix_diff", async (args) => {
      const entry = harnessState.get(args.handle, "harness_matrix_diff");
      if (!entry.analysis) {
        throw new Error("harness_matrix_diff: run harness_run first");
      }
      assertDcTranSession(entry.analysis, "harness_matrix_diff");
      const report = entry.session.matrixDiff({
        stepIndex: args.stepIndex,
        iterationIndex: args.iterationIndex,
      });
      return JSON.stringify({ handle: args.handle, matrixDiff: report });
    }),
  );

  // -------------------------------------------------------------------------
  // harness_first_divergence
  // -------------------------------------------------------------------------

  server.registerTool(
    "harness_first_divergence",
    {
      title: "First Divergence (multi-signal)",
      description:
        "Walk paired iterations in chronological order and return the first " +
        "divergence in each of eight signal classes: " +
        "shape (attempt count / accepted phase / NR mode / matrixSize / gmin- / " +
        "source-stepping), integration (delta, order, method, ag0, ag1, lteDt; " +
        "tran steps only), state (element-state slot at any vintage state0/1/2/3), " +
        "limiting (junction-limiting applied flag or post-limit voltage), rhs " +
        "(preSolveRhs companion-current / excitation cell), matrix (Jacobian " +
        "cell), voltage (post-solve node-voltage cell), convergence (matched " +
        "element's converged-flag disagreement). " +
        "Plus `earliest`: the lowest (stepIndex, iterationIndex) across all eight, " +
        "ties broken by causal upstream-ness (shape < integration < state < " +
        "limiting < rhs < matrix < voltage < convergence) so the result points at " +
        "the cause, not a downstream symptom- e.g. a divergent rhs over an " +
        "identical matrix wins the tie against the voltage it produces. " +
        "Use this first to choose which axis to drill into before fetching a " +
        "full attempt via harness_get_attempt with a slice.\n\n" +
        "For an AC session (after harness_run_ac) this dispatches to the AC " +
        "first-divergence classes instead, returned under `acFirstDivergence`: " +
        "solution (per-MNA-row complex solution), shape (point presence / " +
        "frequency / matrixSize), matrix (complex Jacobian cell), rhs (complex " +
        "loaded excitation cell), plus `earliestPointIndex`. The response's " +
        "`analysis` field says which shape to read.",
      inputSchema: z.object({
        handle: z.string().describe("Harness session handle from harness_start"),
      }),
    },
    wrapTool("harness_first_divergence", async (args) => {
      const entry = harnessState.get(args.handle, "harness_first_divergence");
      if (!entry.analysis) {
        throw new Error("harness_first_divergence: run harness_run or harness_run_ac first");
      }
      if (entry.analysis === "ac") {
        const acReport = entry.session.acFirstDivergence();
        return JSON.stringify({ handle: args.handle, analysis: "ac", acFirstDivergence: acReport });
      }
      const report = entry.session.firstDivergence();
      return JSON.stringify({ handle: args.handle, analysis: entry.analysis, firstDivergence: report });
    }),
  );
}
