// Vitest-only augmentation of ComparisonSession with assertion-style helpers.
// These methods call `expect()`, so keeping them on the bare class would drag
// vitest into any non-test consumer (e.g. the MCP server, which crashes at
// import time with "Vitest failed to access its internal state"). Loaded via
// vitest `setupFiles` so every test sees the methods on every session.

import { expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";

declare module "./comparison-session.js" {
  interface ComparisonSession {
    compareAllSteps(): void;
    compareAllAttempts(): void;
  }
}

ComparisonSession.prototype.compareAllSteps = function (this: ComparisonSession): void {
  const { stepCount } = this.getSummary();
  for (let s = 0; s < stepCount.ours; s++) {
    const stepEnd = this.getStepEnd(s);
    expect(
      stepEnd.dt.withinTol,
      `step ${s} dt: ours=${stepEnd.dt.ours} ngspice=${stepEnd.dt.ngspice} absDelta=${stepEnd.dt.absDelta}`,
    ).toBe(true);
    for (const [label, cv] of Object.entries(stepEnd.nodes)) {
      expect(
        cv.withinTol,
        `step ${s} node ${label}: ours=${cv.ours} ngspice=${cv.ngspice} absDelta=${cv.absDelta}`,
      ).toBe(true);
    }
    for (const [label, cv] of Object.entries(stepEnd.branches)) {
      expect(
        cv.withinTol,
        `step ${s} branch ${label}: ours=${cv.ours} ngspice=${cv.ngspice} absDelta=${cv.absDelta}`,
      ).toBe(true);
    }
    for (const [compLabel, comp] of Object.entries(stepEnd.components)) {
      for (const [slot, cv] of Object.entries(comp.slots ?? {})) {
        expect(
          cv.withinTol,
          `step ${s} ${compLabel}.${slot}: ours=${cv.ours} ngspice=${cv.ngspice} absDelta=${cv.absDelta}`,
        ).toBe(true);
      }
      for (const [pin, cv] of Object.entries(comp.pinCurrents ?? {})) {
        expect(
          cv.withinTol,
          `step ${s} ${compLabel} pin ${pin}: ours=${cv.ours} ngspice=${cv.ngspice} absDelta=${cv.absDelta}`,
        ).toBe(true);
      }
    }
  }
};

ComparisonSession.prototype.compareAllAttempts = function (this: ComparisonSession): void {
  const { entries } = this.getDivergences({ limit: Number.MAX_SAFE_INTEGER });
  if (entries.length === 0) return;
  const first = entries[0];
  const msg =
    `${entries.length} per-iteration divergence(s); first: ${first.category} ` +
    `step ${first.stepIndex}/iter ${first.iteration} ` +
    `${first.componentLabel ? `${first.componentLabel}.` : ""}${first.label} ` +
    `ours=${first.ours} ngspice=${first.ngspice} absDelta=${first.absDelta}`;
  expect(entries.length, msg).toBe(0);
};
