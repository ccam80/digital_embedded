/**
 * MCP simulation tool registrations — interactive simulation for compiled circuits.
 *
 * Requires circuit_compile to be called first to store an engine in session.
 * All tools auto-compile if no engine is stored yet for the given handle.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DefaultSimulatorFacade } from "../../src/headless/default-facade.js";
import type { ComponentRegistry } from "../../src/core/registry.js";
import type { SignalValue } from "../../src/compile/types.js";
import { wrapTool, SessionState } from "./tool-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSignalValue(sv: SignalValue): string {
  if (sv.type === "digital") {
    return String(sv.value);
  }
  const vStr = sv.voltage.toFixed(3) + " V";
  return sv.current !== undefined ? `${vStr}, ${sv.current.toExponential(3)} A` : vStr;
}

function formatAllSignals(signals: Map<string, SignalValue>): string {
  if (signals.size === 0) return "(no labeled signals)";
  const lines: string[] = [];
  for (const [label, sv] of signals) {
    lines.push(`  ${label} = ${formatSignalValue(sv)}`);
  }
  return lines.join("\n");
}

/** Auto-compile if no engine stored yet; returns the coordinator. */
function ensureEngine(
  handle: string,
  facade: DefaultSimulatorFacade,
  session: SessionState,
) {
  if (!session.engines.has(handle)) {
    const circuit = session.getCircuit(handle);
    const coordinator = facade.compile(circuit);
    session.storeEngine(handle, coordinator);
  }
  return session.getEngine(handle);
}

// ---------------------------------------------------------------------------
// registerSimulationTools
// ---------------------------------------------------------------------------

export function registerSimulationTools(
  server: McpServer,
  facade: DefaultSimulatorFacade,
  _registry: ComponentRegistry,
  session: SessionState,
): void {
  // ---------------------------------------------------------------------------
  // circuit_step
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_step",
    {
      title: "Step Simulation",
      description:
        "Advance the compiled simulation by N steps (default 1). " +
        "Auto-compiles if not already compiled. " +
        "Returns a snapshot of all labeled signals after stepping.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
        steps: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Number of steps to advance (default: 1)"),
        clockAdvance: z
          .boolean()
          .optional()
          .describe("Whether to advance clock signals before each step (default: true)"),
      },
    },
    wrapTool<{ handle: string; steps?: number; clockAdvance?: boolean }>(
      "circuit_step error",
      ({ handle, steps = 1, clockAdvance = true }) => {
        const coordinator = ensureEngine(handle, facade, session);
        const opts = { clockAdvance };
        if (steps === 1) {
          facade.step(coordinator, opts);
        } else {
          facade.run(coordinator, steps, opts);
        }
        const signals = coordinator.readAllSignals();
        return `Stepped ${steps} cycle(s). Signals:\n${formatAllSignals(signals)}`;
      },
    ),
  );

  // ---------------------------------------------------------------------------
  // circuit_set_input
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_set_input",
    {
      title: "Set Circuit Input",
      description:
        "Drive a labeled input pin to a specific value in the compiled simulation. " +
        "For digital inputs, value is an integer (0 or 1 for 1-bit, 0-255 for 8-bit, etc.). " +
        "For analog inputs, value is a voltage in volts.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
        label: z.string().describe("Input component label (as shown in the circuit)"),
        value: z.number().describe("Value to set. Digital: integer. Analog: voltage in volts."),
      },
    },
    wrapTool<{ handle: string; label: string; value: number }>(
      "circuit_set_input error",
      ({ handle, label, value }) => {
        const coordinator = ensureEngine(handle, facade, session);
        // Try label-based write via coordinator directly to support both domains
        const addr = coordinator.compiled.labelSignalMap.get(label);
        if (!addr) {
          const available = [...coordinator.compiled.labelSignalMap.keys()].join(", ");
          throw new Error(
            `Label "${label}" not found. Available labels: ${available || "(none)"}`,
          );
        }
        const sv: SignalValue =
          addr.domain === "digital"
            ? { type: "digital", value: Math.round(value) }
            : { type: "analog", voltage: value };
        coordinator.writeSignal(addr, sv);
        return `Set input ${label} = ${value}`;
      },
    ),
  );

  // ---------------------------------------------------------------------------
  // circuit_read_output
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_read_output",
    {
      title: "Read Circuit Output",
      description:
        "Read the current value of a labeled signal in the compiled simulation. " +
        "Works for both input and output components.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
        label: z.string().describe("Component label to read"),
      },
    },
    wrapTool<{ handle: string; label: string }>(
      "circuit_read_output error",
      ({ handle, label }) => {
        const coordinator = ensureEngine(handle, facade, session);
        const addr = coordinator.compiled.labelSignalMap.get(label);
        if (!addr) {
          const available = [...coordinator.compiled.labelSignalMap.keys()].join(", ");
          throw new Error(
            `Label "${label}" not found. Available labels: ${available || "(none)"}`,
          );
        }
        const sv = coordinator.readSignal(addr);
        return `${label} = ${formatSignalValue(sv)}`;
      },
    ),
  );

  // ---------------------------------------------------------------------------
  // circuit_read_all_signals
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_read_all_signals",
    {
      title: "Read All Signals",
      description:
        "Read all labeled signals in the compiled simulation at once. " +
        "Returns a table of signal values with domain info (digital / analog).",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
      },
    },
    wrapTool<{ handle: string }>(
      "circuit_read_all_signals error",
      ({ handle }) => {
        const coordinator = ensureEngine(handle, facade, session);
        const signals = coordinator.readAllSignals();
        return `Signals:\n${formatAllSignals(signals)}`;
      },
    ),
  );

  // ---------------------------------------------------------------------------
  // circuit_sample_at_times
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_sample_at_times",
    {
      title: "Sample Signals at Times",
      description:
        "Run the analog simulation to each target time in order, capturing all labeled " +
        "signal values at each sample point. Times must be monotonically increasing. " +
        "Runs without yielding to the event loop — fast for headless/test use. " +
        "Returns a table of signal values at each time.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
        times: z
          .array(z.number())
          .min(1)
          .describe("Sorted list of simulation times (seconds) to sample at"),
        wallBudgetMs: z
          .number()
          .optional()
          .describe("Wall-clock timeout in milliseconds (default: 30000)"),
      },
    },
    wrapTool<{ handle: string; times: number[]; wallBudgetMs?: number }>(
      "circuit_sample_at_times error",
      async ({ handle, times, wallBudgetMs }) => {
        const coordinator = ensureEngine(handle, facade, session);
        const snapshots = await facade.sampleAtTimes(
          coordinator,
          times,
          () => coordinator.readAllSignals(),
          wallBudgetMs,
        );
        const lines: string[] = [`Samples (${times.length} time points):`];
        for (let i = 0; i < times.length; i++) {
          lines.push(`  t=${times[i]!.toExponential(4)} s:`);
          lines.push(formatAllSignals(snapshots[i]!).replace(/^/gm, '  '));
        }
        return lines.join("\n");
      },
    ),
  );

  // ---------------------------------------------------------------------------
  // circuit_dc_op
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_dc_op",
    {
      title: "DC Operating Point",
      description:
        "Compute the DC operating point of the compiled analog or mixed-signal circuit. " +
        "Returns node voltages and convergence information. " +
        "Returns an error if the circuit has no analog domain.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
      },
    },
    wrapTool<{ handle: string }>(
      "circuit_dc_op error",
      ({ handle }) => {
        const coordinator = ensureEngine(handle, facade, session);
        if (!coordinator.supportsDcOp()) {
          return "DC operating point not available (no analog domain)";
        }
        const result = coordinator.dcOperatingPoint();
        if (!result) {
          return "DC operating point not available (no analog domain)";
        }
        const lines: string[] = [
          `DC Operating Point:`,
          `  Converged: ${result.converged}`,
          `  Method: ${result.method}`,
          `  Iterations: ${result.iterations}`,
        ];
        if (result.nodeVoltages.length > 0) {
          lines.push(`  Node voltages:`);
          for (let i = 0; i < result.nodeVoltages.length; i++) {
            lines.push(`    node[${i}] = ${result.nodeVoltages[i]!.toFixed(6)} V`);
          }
        }
        if (result.diagnostics.length > 0) {
          lines.push(`  Diagnostics:`);
          for (const d of result.diagnostics) {
            lines.push(`    [${d.severity}] ${d.message}`);
          }
        }
        return lines.join("\n");
      },
    ),
  );

  // ---------------------------------------------------------------------------
  // circuit_ac_sweep
  // ---------------------------------------------------------------------------

  server.registerTool(
    "circuit_ac_sweep",
    {
      title: "AC Frequency Sweep",
      description:
        "Run an AC small-signal frequency sweep analysis on the compiled analog or mixed-signal circuit. " +
        "Returns magnitude (dB) and phase (degrees) at each frequency point for all output nodes. " +
        "Returns an error if the circuit has no analog domain or does not support AC analysis.",
      inputSchema: {
        handle: z.string().describe("Circuit handle"),
        fStart: z.number().positive().describe("Start frequency in Hz (e.g. 1)"),
        fStop: z.number().positive().describe("Stop frequency in Hz (e.g. 1e6)"),
        points: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe("Points per sweep unit (default: 50). For 'dec'/'oct' this is points per decade/octave; for 'lin' this is total points."),
        sweepType: z
          .enum(["lin", "dec", "oct"])
          .optional()
          .describe("Sweep type: 'lin' (linear), 'dec' (decades, default), 'oct' (octaves)"),
        sourceLabel: z
          .string()
          .describe("Label of the AC voltage source providing excitation (e.g. 'V1')"),
        outputNodes: z
          .array(z.string())
          .describe("Labels of output nodes to measure (e.g. ['Vout', 'V2'])"),
      },
    },
    wrapTool<{ handle: string; fStart: number; fStop: number; points?: number; sweepType?: "lin" | "dec" | "oct"; sourceLabel: string; outputNodes: string[] }>(
      "circuit_ac_sweep error",
      ({ handle, fStart, fStop, points = 50, sweepType = "dec", sourceLabel, outputNodes }) => {
        const coordinator = ensureEngine(handle, facade, session);
        if (!coordinator.supportsAcSweep()) {
          return "AC analysis not available (no analog domain)";
        }
        const result = coordinator.acAnalysis({
          type: sweepType,
          fStart,
          fStop,
          numPoints: points,
          sourceLabel,
          outputNodes,
        });
        if (!result) {
          return "AC analysis not available (no analog domain)";
        }

        const lines: string[] = [
          `AC Sweep: ${fStart} Hz – ${fStop} Hz, ${points} points`,
        ];

        if (result.diagnostics.length > 0) {
          lines.push(`Diagnostics:`);
          for (const d of result.diagnostics) {
            lines.push(`  [${d.severity}] ${d.message}`);
          }
        }

        const nodeLabels = [...result.magnitude.keys()];
        if (nodeLabels.length === 0) {
          lines.push("No output nodes in result.");
          return lines.join("\n");
        }

        // Show first 10 frequency points per node to keep output manageable
        const maxPoints = Math.min(10, result.frequencies.length);
        for (const nodeLabel of nodeLabels) {
          const mag = result.magnitude.get(nodeLabel)!;
          const ph = result.phase.get(nodeLabel)!;
          lines.push(`\nNode: ${nodeLabel}`);
          lines.push(`  Freq (Hz)         Magnitude (dB)   Phase (deg)`);
          for (let i = 0; i < maxPoints; i++) {
            const f = result.frequencies[i]!;
            lines.push(
              `  ${f.toExponential(3).padEnd(18)} ${mag[i]!.toFixed(3).padEnd(17)} ${ph[i]!.toFixed(3)}`,
            );
          }
          if (result.frequencies.length > maxPoints) {
            lines.push(`  ... (${result.frequencies.length - maxPoints} more points)`);
          }
        }

        return lines.join("\n");
      },
    ),
  );
}
