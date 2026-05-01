/**
 * Tests for AnalogEngine interface and associated types.
 *
 * Verifies that all types from circuits-engine-spec.md sections 2 and 7 are
 * defined, exported, and structurally correct. These are type-level tests-
 * they exercise TypeScript assignability by constructing literal objects and
 * asserting runtime field values.
 */

import { describe, it, expect } from "vitest";
import type { Engine, CompiledCircuit, EngineState, EngineChangeListener, MeasurementObserver } from "@/core/engine-interface";
import type {
  AnalogEngine,
  SimulationParams,
  DcOpResult,
  DiagnosticSuggestion,
  CompiledAnalogCircuit,
} from "@/core/analog-engine-interface";
import type { Diagnostic, DiagnosticCode } from "@/compile/types";
import type { AcParams, AcResult } from "@/solver/analog/ac-analysis";
import { DEFAULT_SIMULATION_PARAMS } from "@/core/analog-engine-interface";
import { ConvergenceLog } from "@/solver/analog/convergence-log";

// ---------------------------------------------------------------------------
// AnalogEngineTypes
// ---------------------------------------------------------------------------

describe("AnalogEngineTypes", () => {
  it("simulation_params_has_all_fields", () => {
    const params: SimulationParams = {
      maxTimeStep: 5e-6,
      minTimeStep: 5e-17,
      reltol: 1e-3,
      voltTol: 1e-6,
      abstol: 1e-12,
      chargeTol: 1e-14,
      trtol: 7.0,
      maxIterations: 100,
      transientMaxIterations: 10,
      integrationMethod: "trapezoidal",
      dcTrcvMaxIter: 50,
      gmin: 1e-12,
      nodeDamping: false,
    };

    expect(params.maxTimeStep).toBe(5e-6);
    expect(params.minTimeStep).toBe(5e-17);
    expect(params.reltol).toBe(1e-3);
    expect(params.voltTol).toBe(1e-6);
    expect(params.chargeTol).toBe(1e-14);
    expect(params.maxIterations).toBe(100);
    expect(params.integrationMethod).toBe("trapezoidal");
    expect(params.gmin).toBe(1e-12);

    // Verify DEFAULT_SIMULATION_PARAMS matches the spec
    expect(DEFAULT_SIMULATION_PARAMS.maxTimeStep).toBe(10e-6);
    expect(DEFAULT_SIMULATION_PARAMS.minTimeStep).toBe(1e-15);
    expect(DEFAULT_SIMULATION_PARAMS.firstStep).toBe(1e-9);
    expect(DEFAULT_SIMULATION_PARAMS.reltol).toBe(1e-3);
    expect(DEFAULT_SIMULATION_PARAMS.voltTol).toBe(1e-6);
    expect(DEFAULT_SIMULATION_PARAMS.chargeTol).toBe(1e-14);
    expect(DEFAULT_SIMULATION_PARAMS.maxIterations).toBe(100);
    expect(DEFAULT_SIMULATION_PARAMS.integrationMethod).toBe("trapezoidal");
    expect(DEFAULT_SIMULATION_PARAMS.gmin).toBe(1e-12);
  });

  it("dc_op_result_structure", () => {
    const result: DcOpResult = {
      converged: true,
      method: "direct",
      iterations: 5,
      nodeVoltages: new Float64Array([0, 3.3, 5.0]),
      diagnostics: [],
    };

    expect(result.converged).toBe(true);
    expect(result.method).toBe("direct");
    expect(result.iterations).toBe(5);
    expect(result.nodeVoltages).toBeInstanceOf(Float64Array);
    expect(result.nodeVoltages[1]).toBe(3.3);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("compiled_analog_extends_compiled", () => {
    // Construct a CompiledAnalogCircuit and assign to CompiledCircuit to
    // verify structural subtyping.
    const compiled: CompiledAnalogCircuit = {
      netCount: 5,
      componentCount: 3,
      nodeCount: 4,
      elementCount: 3,
      labelToNodeId: new Map([["R1", 1], ["R2", 2]]),
      wireToNodeId: new Map(),
      statePool: {
        states: [new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0)],
        state0: new Float64Array(0),
        state1: new Float64Array(0),
        state2: new Float64Array(0),
        state3: new Float64Array(0),
        state4: new Float64Array(0),
        state5: new Float64Array(0),
        state6: new Float64Array(0),
        state7: new Float64Array(0),
        totalSlots: 0,
        tranStep: 0,
      },
    };

    // Assignment to CompiledCircuit must be valid (structural subtype check)
    const base: CompiledCircuit = compiled;

    expect(base.netCount).toBe(5);
    expect(base.componentCount).toBe(3);
    expect(compiled.nodeCount).toBe(4);
    expect(compiled.elementCount).toBe(3);
    expect(compiled.labelToNodeId.get("R1")).toBe(1);
    expect(compiled.wireToNodeId.size).toBe(0);
  });

  it("solver_diagnostic_codes_exhaustive", () => {
    // Every code from the spec's diagnostic table must be a valid
    // DiagnosticCode value.
    const allCodes: DiagnosticCode[] = [
      "singular-matrix",
      "voltage-source-loop",
      "floating-node",
      "inductor-loop",
      "no-ground",
      "convergence-failed",
      "timestep-too-small",
      "width-mismatch",
      "unconnected-input",
      "unconnected-output",
      "multi-driver-no-tristate",
      "missing-subcircuit",
      "label-collision",
      "combinational-loop",
      "missing-property",
      "unknown-component",
    ];

    // All 16 codes must be present
    expect(allCodes).toHaveLength(16);

    // Each code is a non-empty string
    for (const code of allCodes) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }

    // No duplicates
    const unique = new Set(allCodes);
    expect(unique.size).toBe(allCodes.length);

    // Construct a Diagnostic using a code- verifies assignability
    const diag: Diagnostic = {
      code: "convergence-failed",
      severity: "error",
      message: "Newton-Raphson failed to converge",
      explanation: "The solver exceeded maxIterations without finding a solution.",
      suggestions: [],
    };
    expect(diag.code).toBe("convergence-failed");
    expect(diag.severity).toBe("error");
  });

  it("analog_engine_extends_engine", () => {
    // Construct a minimal mock AnalogEngine and assign it to Engine to verify
    // that AnalogEngine is a structural subtype of Engine.
    const mockAnalogEngine: AnalogEngine = {
      // Engine base methods
      init(_circuit: CompiledCircuit): void {},
      reset(): void {},
      dispose(): void {},
      step(): void {},
      start(): void {},
      stop(): void {},
      getState(): EngineState {
        return "STOPPED" as EngineState;
      },
      addChangeListener(_listener: EngineChangeListener): void {},
      removeChangeListener(_listener: EngineChangeListener): void {},

      // AnalogEngine-specific methods and properties
      dcOperatingPoint(): DcOpResult {
        return {
          converged: true,
          method: "direct",
          iterations: 1,
          nodeVoltages: new Float64Array(0),
          diagnostics: [],
        };
      },
      get simTime(): number { return 0; },
      get lastDt(): number { return 1e-6; },
      getNodeVoltage(_nodeId: number): number { return 0; },
      setNodeVoltage(_nodeId: number, _voltage: number): void {},
      getBranchCurrent(_branchId: number): number { return 0; },
      getElementCurrent(_elementId: number): number { return 0; },
      getElementPower(_elementId: number): number { return 0; },
      configure(_params: Partial<SimulationParams>): void {},
      onDiagnostic(_callback: (diag: Diagnostic) => void): void {},
      convergenceLog: new ConvergenceLog(),
      addBreakpoint(_time: number): void {},
      clearBreakpoints(): void {},
      acAnalysis(_params: AcParams): AcResult {
        return {
          frequencies: new Float64Array(0),
          magnitude: new Map(),
          phase: new Map(),
          real: new Map(),
          imag: new Map(),
          diagnostics: [],
        };
      },
      addMeasurementObserver(_observer: MeasurementObserver): void {},
      removeMeasurementObserver(_observer: MeasurementObserver): void {},
      getElementPinCurrents(_elementId: number): number[] { return []; },
    };

    // Assignment to Engine base must be valid
    const base: Engine = mockAnalogEngine;

    expect(typeof base.step).toBe("function");
    expect(typeof base.init).toBe("function");
    expect(typeof mockAnalogEngine.dcOperatingPoint).toBe("function");
    expect(typeof mockAnalogEngine.addBreakpoint).toBe("function");
    expect(typeof mockAnalogEngine.clearBreakpoints).toBe("function");

    // Call dcOperatingPoint to verify it works at runtime
    const result = mockAnalogEngine.dcOperatingPoint();
    expect(result.converged).toBe(true);
    expect(result.method).toBe("direct");
  });

  it("diagnostic_suggestion_structure", () => {
    const suggestion: DiagnosticSuggestion = {
      text: "Add a ground connection to node 3",
      automatable: false,
    };
    expect(suggestion.text).toBe("Add a ground connection to node 3");
    expect(suggestion.automatable).toBe(false);
    expect(suggestion.patch).toBeUndefined();

    const automatableSuggestion: DiagnosticSuggestion = {
      text: "Connect floating node to ground",
      automatable: true,
      patch: { op: "connect", from: "node3", to: "GND" },
    };
    expect(automatableSuggestion.automatable).toBe(true);
    expect(automatableSuggestion.patch).toBeDefined();
  });

  it("solver_diagnostic_optional_fields", () => {
    // Diagnostic with all optional fields populated
    const diag: Diagnostic = {
      code: "floating-node",
      severity: "warning",
      message: "Node 2 is floating",
      explanation: "Node 2 has no DC path to ground.",
      suggestions: [{ text: "Add a resistor to ground", automatable: false }],
      involvedNodes: [2],
      involvedElements: [5, 7],
      simTime: 1.5e-6,
      detail: "Node degree: 1",
    };

    expect(diag.involvedNodes).toEqual([2]);
    expect(diag.involvedElements).toEqual([5, 7]);
    expect(diag.simTime).toBe(1.5e-6);
    expect(diag.detail).toBe("Node degree: 1");
    expect(diag.suggestions).toHaveLength(1);
  });

  it("simulation_params_integration_methods", () => {
    const methods: SimulationParams["integrationMethod"][] = [
      "trapezoidal",
      "gear",
    ];

    for (const method of methods) {
      const params: SimulationParams = { ...DEFAULT_SIMULATION_PARAMS, integrationMethod: method };
      expect(params.integrationMethod).toBe(method);
    }
  });

  it("dc_op_result_methods", () => {
    const methods: DcOpResult["method"][] = ["direct", "dynamic-gmin", "gillespie-src"];

    for (const method of methods) {
      const result: DcOpResult = {
        converged: false,
        method,
        iterations: 100,
        nodeVoltages: new Float64Array(0),
        diagnostics: [],
      };
      expect(result.method).toBe(method);
    }
  });
});
