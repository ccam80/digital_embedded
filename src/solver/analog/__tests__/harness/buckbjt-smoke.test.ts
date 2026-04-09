/**
 * Smoke test: ComparisonSession on buckbjt circuit.
 *
 * Exercises the full pipeline: load .dts + .cir, run transient,
 * query specific component traces and iteration data.
 *
 * Requires the extended ngspice DLL.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { accessSync } from "fs";
import { ComparisonSession } from "./comparison-session.js";

const DLL_PATH = resolve(
  process.cwd(), "ref/ngspice/visualc-shared/x64/Release/bin/spice.dll",
);

let dllAvailable = false;
try { accessSync(DLL_PATH); dllAvailable = true; } catch { /* */ }

const describeIfDll = dllAvailable ? describe : describe.skip;

describeIfDll("ComparisonSession — buckbjt smoke test", () => {
  it("transient: CCAP in capacitor and BJT junctions over first steps/retries", async () => {
    const session = new ComparisonSession({
      dtsPath: "fixtures/buckbjt.dts",

      dllPath: DLL_PATH,
      maxOurSteps: 20,
    });
    await session.init();
    await session.runTransient(0, 100e-9);

    const summary = session.getSummary();
    console.log("\n=== SESSION SUMMARY ===");
    console.log(`Our steps: ${summary.stepCount.ours}, ngspice steps: ${summary.stepCount.ngspice}`);
    console.log(`Comparisons: ${summary.totals.compared} (${summary.totals.passed} pass, ${summary.totals.failed} fail)`);
    if (summary.firstDivergence) {
      console.log(`First divergence: step ${summary.firstDivergence.stepIndex}, iter ${summary.firstDivergence.iterationIndex}, worst=${summary.firstDivergence.worstLabel} delta=${summary.firstDivergence.absDelta.toExponential(3)}`);
    }
    if (session.errors.length > 0) {
      console.log("Errors:", session.errors);
    }

    // --- Q1: CCAP in capacitors and BJT junctions over first few steps ---
    console.log("\n=== CCAP TRACES (first 5 steps) ===");

    // Find all components and look for capacitor / BJT types
    const ourSteps = session.ourSession!.steps;
    const maxSteps = Math.min(ourSteps.length, 5);

    for (let si = 0; si < maxSteps; si++) {
      const stepEnd = session.getStepEnd(si);
      console.log(`\n--- Step ${si} (t_ours=${stepEnd.stepStartTime.ours.toExponential(3)}, t_ng=${stepEnd.stepStartTime.ngspice.toExponential(3)}) ---`);
      console.log(`  converged: ours=${stepEnd.converged.ours} ng=${stepEnd.converged.ngspice}`);
      console.log(`  iters: ours=${stepEnd.iterationCount.ours} ng=${stepEnd.iterationCount.ngspice}`);

      // Show attempts if any
      const step = ourSteps[si];
      if (step.attempts && step.attempts.length > 1) {
        console.log(`  RETRIES: ${step.attempts.length} attempts`);
        for (let a = 0; a < step.attempts.length; a++) {
          const att = step.attempts[a];
          console.log(`    attempt ${a}: dt=${att.dt.toExponential(3)} iters=${att.iterationCount} converged=${att.converged}`);
        }
      }

      // CCAP slots in each component
      for (const [label, entry] of Object.entries(stepEnd.components)) {
        const ccapSlots = Object.entries(entry.slots).filter(([name]) =>
          name.startsWith("CCAP") || name === "Q_BE" || name === "Q_BC" || name === "Q_CS");
        if (ccapSlots.length > 0) {
          console.log(`  ${label}:`);
          for (const [slotName, cv] of ccapSlots) {
            const status = cv.withinTol ? "OK" : `DIFF`;
            console.log(`    ${slotName}: ours=${cv.ours.toExponential(4)} ng=${cv.ngspice.toExponential(4)} delta=${cv.absDelta.toExponential(3)} ${status}`);
          }
        }
      }
    }

    expect(ourSteps.length).toBeGreaterThan(0);
  }, 60_000);

  it("transient: inductor current divergence over iterations in step 1", async () => {
    const session = new ComparisonSession({
      dtsPath: "fixtures/buckbjt.dts",

      dllPath: DLL_PATH,
      maxOurSteps: 20,
    });
    await session.init();
    await session.runTransient(0, 100e-9);

    const ourSteps = session.ourSession!.steps;
    if (ourSteps.length < 2) {
      console.log("Not enough steps for step 1 analysis");
      return;
    }

    console.log("\n=== INDUCTOR CURRENT — STEP 1 ITERATIONS ===");
    const iters = session.getIterations(1);
    console.log(`Step 1: ${iters.length} iterations`);

    // Find inductor-related nodes (branch currents)
    for (const iter of iters) {
      // Look for branch nodes (inductors have branch currents in the solution vector)
      const inductorNodes = Object.entries(iter.nodes).filter(([label]) =>
        label.toLowerCase().includes("l") || label.toLowerCase().includes("ind"));

      console.log(`\n  Iteration ${iter.iteration}:`);
      console.log(`    noncon: ours=${iter.noncon.ours} ng=${iter.noncon.ngspice}`);

      // Show all node voltages for this iteration
      for (const [label, cv] of Object.entries(iter.nodes)) {
        const status = cv.withinTol ? "" : " ** MISMATCH";
        if (!cv.withinTol || label.toLowerCase().includes("l")) {
          console.log(`    ${label}: ours=${cv.ours.toExponential(6)} ng=${cv.ngspice.toExponential(6)} delta=${cv.delta.toExponential(3)}${status}`);
        }
      }

      // Show inductor-related component states
      for (const [compLabel, slots] of Object.entries(iter.components)) {
        if (compLabel.toLowerCase().includes("l") || compLabel.toLowerCase().includes("ind")) {
          console.log(`    ${compLabel} state:`);
          for (const [slotName, cv] of Object.entries(slots)) {
            const status = cv.withinTol ? "" : " ** MISMATCH";
            console.log(`      ${slotName}: ours=${cv.ours.toExponential(4)} ng=${cv.ngspice.toExponential(4)} delta=${cv.delta.toExponential(3)}${status}`);
          }
        }
      }
    }

    expect(iters.length).toBeGreaterThan(0);
  }, 60_000);

  it("transient: PNP BJT internal node agreement in step 1", async () => {
    const session = new ComparisonSession({
      dtsPath: "fixtures/buckbjt.dts",

      dllPath: DLL_PATH,
      maxOurSteps: 20,
    });
    await session.init();
    await session.runTransient(0, 100e-9);

    const ourSteps = session.ourSession!.steps;
    if (ourSteps.length < 2) {
      console.log("Not enough steps for step 1 analysis");
      return;
    }

    // Find BJT components
    console.log("\n=== BJT NODE AGREEMENT — STEP 1 ===");
    const stepEnd = session.getStepEnd(1);

    // Show all BJT component states
    for (const [label, entry] of Object.entries(stepEnd.components)) {
      // Check if it looks like a BJT (has VBE, VBC slots)
      if ("VBE" in entry.slots || "VBC" in entry.slots) {
        console.log(`\n  ${label} (BJT):`);

        // Group by agreement
        const agreeing: string[] = [];
        const disagreeing: string[] = [];

        for (const [slotName, cv] of Object.entries(entry.slots)) {
          if (isNaN(cv.ngspice)) continue; // no ngspice data for this slot
          if (cv.withinTol) {
            agreeing.push(slotName);
          } else {
            disagreeing.push(slotName);
          }
          const status = cv.withinTol ? "OK" : "MISMATCH";
          console.log(`    ${slotName.padEnd(12)} ours=${cv.ours.toExponential(6)} ng=${cv.ngspice.toExponential(6)} delta=${cv.absDelta.toExponential(3)} ${status}`);
        }

        console.log(`\n    AGREE (${agreeing.length}): ${agreeing.join(", ")}`);
        console.log(`    DISAGREE (${disagreeing.length}): ${disagreeing.join(", ")}`);
      }
    }

    // Also trace BJT nodes (pin voltages)
    console.log("\n=== BJT PIN VOLTAGES — STEP 1 ===");
    for (const [label, cv] of Object.entries(stepEnd.nodes)) {
      if (label.toUpperCase().includes("Q")) {
        const status = cv.withinTol ? "OK" : "MISMATCH";
        console.log(`  ${label}: ours=${cv.ours.toExponential(6)} ng=${cv.ngspice.toExponential(6)} delta=${cv.absDelta.toExponential(3)} ${status}`);
      }
    }

    expect(Object.keys(stepEnd.components).length).toBeGreaterThan(0);
  }, 60_000);
});
