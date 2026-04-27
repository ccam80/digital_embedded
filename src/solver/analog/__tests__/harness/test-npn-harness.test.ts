import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { existsSync } from "fs";
import { ComparisonSession } from "./comparison-session.js";

const DLL_PATH = resolve(process.cwd(), "ref/ngspice/visualc-shared/x64/Release/bin/spice.dll");
const HAS_DLL = DLL_PATH !== "" && existsSync(DLL_PATH);
const describeGate = HAS_DLL ? describe : describe.skip;

describeGate("NPN-CE harness branch value test", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: "fixtures/npn-ce-harness.dts",
      dllPath: DLL_PATH,
    });
    await session.runDcOp();
  }, 60_000);

  it("captures branch values on both sides", async () => {
    const map = session.sessionMap();
    console.log("\n=== SESSION MAP ===");
    console.log("Analysis:", map.analysis);
    console.log("Ours steps:", map.ours.stepCount);
    console.log("Ngspice steps:", map.ngspice.stepCount);
    
    if (map.ours.stepCount > 0) {
      const ourStep = map.ours.steps[0];
      console.log("\nOur Step 0:", { attempts: ourStep.attempts.length, converged: ourStep.converged });
    }
    
    if (map.ngspice.stepCount > 0) {
      const ngStep = map.ngspice.steps[0];
      console.log("Ngspice Step 0:", { attempts: ngStep.attempts.length, converged: ngStep.converged });
    }

    // Get step detail for first step
    if (map.ours.stepCount > 0) {
      const stepDetail = session.getStep({ index: 0 });
      console.log("\n=== STEP DETAIL (index 0) ===");
      console.log("Our attempts:", stepDetail.ours.length);
      console.log("Ngspice attempts:", stepDetail.ngspice.length);
      
      if (stepDetail.ours.length > 0) {
        const att = stepDetail.ours[0];
        console.log("\nOur attempt 0:", { phase: att.phase, outcome: att.outcome, iterCount: att.iterationCount });
        
        // Get attempt detail to see branch values
        const attDetail = session.getAttempt({
          stepIndex: 0,
          phase: att.phase,
          phaseAttemptIndex: 0,
        });
        
        if (attDetail.ourAttempt && attDetail.iterations.length > 0) {
          const iter = attDetail.iterations[0];
          if (iter.ours?.branchValues) {
            console.log("Our branch keys:", Object.keys(iter.ours.branchValues).slice(0, 5));
            console.log("Our branch count:", Object.keys(iter.ours.branchValues).length);
          } else {
            console.log("Our branchValues: MISSING OR EMPTY");
          }
        }
      }
      
      if (stepDetail.ngspice.length > 0) {
        const att = stepDetail.ngspice[0];
        console.log("\nNgspice attempt 0:", { phase: att.phase, outcome: att.outcome, iterCount: att.iterationCount });
        
        const attDetail = session.getAttempt({
          stepIndex: 0,
          phase: att.phase,
          phaseAttemptIndex: 0,
        });
        
        if (attDetail.ngspiceAttempt && attDetail.iterations.length > 0) {
          const iter = attDetail.iterations[0];
          if (iter.ngspice?.branchValues) {
            console.log("Ngspice branch keys:", Object.keys(iter.ngspice.branchValues).slice(0, 5));
            console.log("Ngspice branch count:", Object.keys(iter.ngspice.branchValues).length);
          } else {
            console.log("Ngspice branchValues: MISSING OR EMPTY");
          }
        }
      }
    }
    
    expect(session).toBeDefined();
  });
});
