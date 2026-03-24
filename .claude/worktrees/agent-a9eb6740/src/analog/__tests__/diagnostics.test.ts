/**
 * Tests for the DiagnosticCollector and makeDiagnostic helper.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DiagnosticCollector, makeDiagnostic, type ConvergenceTrace } from "../diagnostics.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";

describe("DiagnosticCollector", () => {
  let collector: DiagnosticCollector;

  beforeEach(() => {
    collector = new DiagnosticCollector();
  });

  describe("emits_to_registered_callbacks", () => {
    it("should dispatch emitted diagnostic to all registered callbacks", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      collector.onDiagnostic(callback1);
      collector.onDiagnostic(callback2);

      const diag: SolverDiagnostic = {
        code: "singular-matrix",
        severity: "error",
        summary: "Singular matrix detected",
        explanation: "The matrix is singular",
        suggestions: [],
      };

      collector.emit(diag);

      expect(callback1).toHaveBeenCalledOnce();
      expect(callback1).toHaveBeenCalledWith(diag);
      expect(callback2).toHaveBeenCalledOnce();
      expect(callback2).toHaveBeenCalledWith(diag);
    });
  });

  describe("collects_all_diagnostics", () => {
    it("should collect all emitted diagnostics in order", () => {
      const diag1: SolverDiagnostic = {
        code: "singular-matrix",
        severity: "error",
        summary: "Singular matrix",
        explanation: "Matrix is singular",
        suggestions: [],
      };

      const diag2: SolverDiagnostic = {
        code: "convergence-failed",
        severity: "warning",
        summary: "Convergence failed",
        explanation: "NR did not converge",
        suggestions: [],
      };

      const diag3: SolverDiagnostic = {
        code: "no-ground",
        severity: "error",
        summary: "No ground element",
        explanation: "Circuit has no ground",
        suggestions: [],
      };

      collector.emit(diag1);
      collector.emit(diag2);
      collector.emit(diag3);

      const collected = collector.getDiagnostics();
      expect(collected).toHaveLength(3);
      expect(collected[0]).toBe(diag1);
      expect(collected[1]).toBe(diag2);
      expect(collected[2]).toBe(diag3);
    });
  });

  describe("clear_resets", () => {
    it("should clear collected diagnostics when clear is called", () => {
      const diag: SolverDiagnostic = {
        code: "singular-matrix",
        severity: "error",
        summary: "Singular matrix",
        explanation: "Matrix is singular",
        suggestions: [],
      };

      collector.emit(diag);
      expect(collector.getDiagnostics()).toHaveLength(1);

      collector.clear();
      expect(collector.getDiagnostics()).toHaveLength(0);
    });
  });

  describe("remove_listener_stops_delivery", () => {
    it("should stop calling a listener after removal", () => {
      const callback = vi.fn();

      collector.onDiagnostic(callback);

      const diag1: SolverDiagnostic = {
        code: "singular-matrix",
        severity: "error",
        summary: "Singular matrix",
        explanation: "Matrix is singular",
        suggestions: [],
      };

      collector.emit(diag1);
      expect(callback).toHaveBeenCalledOnce();

      collector.removeDiagnosticListener(callback);

      const diag2: SolverDiagnostic = {
        code: "convergence-failed",
        severity: "warning",
        summary: "Convergence failed",
        explanation: "NR did not converge",
        suggestions: [],
      };

      collector.emit(diag2);
      expect(callback).toHaveBeenCalledOnce();
    });
  });
});

describe("makeDiagnostic", () => {
  describe("fills_required_fields", () => {
    it("should set code, severity, and summary", () => {
      const diag = makeDiagnostic(
        "singular-matrix",
        "error",
        "Singular matrix detected"
      );

      expect(diag.code).toBe("singular-matrix");
      expect(diag.severity).toBe("error");
      expect(diag.summary).toBe("Singular matrix detected");
    });

    it("should default suggestions to empty array", () => {
      const diag = makeDiagnostic(
        "convergence-failed",
        "warning",
        "NR did not converge"
      );

      expect(diag.suggestions).toEqual([]);
    });

    it("should default involvedNodes to undefined", () => {
      const diag = makeDiagnostic("no-ground", "error", "No ground element");

      expect(diag.involvedNodes).toBeUndefined();
    });

    it("should allow overriding explanation via opts", () => {
      const explanation = "Detailed explanation here";
      const diag = makeDiagnostic(
        "singular-matrix",
        "error",
        "Singular matrix",
        { explanation }
      );

      expect(diag.explanation).toBe(explanation);
    });

    it("should allow overriding suggestions via opts", () => {
      const suggestions = [
        { text: "Add a ground element", automatable: false },
      ];
      const diag = makeDiagnostic(
        "no-ground",
        "error",
        "No ground element",
        { suggestions }
      );

      expect(diag.suggestions).toBe(suggestions);
    });

    it("should allow setting involvedNodes via opts", () => {
      const involvedNodes = [1, 2, 3];
      const diag = makeDiagnostic(
        "floating-node",
        "warning",
        "Floating node",
        { involvedNodes }
      );

      expect(diag.involvedNodes).toBe(involvedNodes);
    });

    it("should allow setting involvedElements via opts", () => {
      const involvedElements = [0, 5];
      const diag = makeDiagnostic(
        "singular-matrix",
        "error",
        "Singular matrix",
        { involvedElements }
      );

      expect(diag.involvedElements).toBe(involvedElements);
    });

    it("should allow setting simTime and detail via opts", () => {
      const simTime = 1.5e-6;
      const detail = "Additional context";
      const diag = makeDiagnostic(
        "convergence-failed",
        "error",
        "Convergence failed",
        { simTime, detail }
      );

      expect(diag.simTime).toBe(simTime);
      expect(diag.detail).toBe(detail);
    });
  });
});

describe("ConvergenceTrace type", () => {
  it("should have correct type structure", () => {
    const trace: ConvergenceTrace = {
      largestChangeElement: 5,
      largestChangeNode: 3,
      oscillating: false,
      iteration: 10,
      fallbackLevel: "none",
    };

    expect(trace.largestChangeElement).toBe(5);
    expect(trace.largestChangeNode).toBe(3);
    expect(trace.oscillating).toBe(false);
    expect(trace.iteration).toBe(10);
    expect(trace.fallbackLevel).toBe("none");
  });

  it("should support all fallbackLevel variants", () => {
    const trace1: ConvergenceTrace = {
      largestChangeElement: 0,
      largestChangeNode: 0,
      oscillating: false,
      iteration: 0,
      fallbackLevel: "none",
    };

    const trace2: ConvergenceTrace = {
      largestChangeElement: 0,
      largestChangeNode: 0,
      oscillating: false,
      iteration: 0,
      fallbackLevel: "gmin",
    };

    const trace3: ConvergenceTrace = {
      largestChangeElement: 0,
      largestChangeNode: 0,
      oscillating: false,
      iteration: 0,
      fallbackLevel: "source-step",
    };

    expect(trace1.fallbackLevel).toBe("none");
    expect(trace2.fallbackLevel).toBe("gmin");
    expect(trace3.fallbackLevel).toBe("source-step");
  });
});
