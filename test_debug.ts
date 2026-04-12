import { computeWaveformValue } from "./src/components/sources/ac-voltage-source.js";

// Manually simulate what nextBreakpoint should return
const frequency = 1000;
const phase = 0;
const riseTime = 1e-9;
const fallTime = 1e-9;

const period = 1 / frequency;
const halfPeriod = period / 2;
const phaseShift = phase / (2 * Math.PI * frequency);

console.log("period:", period);
console.log("halfPeriod:", halfPeriod);
console.log("phaseShift:", phaseShift);

// Expected edges at t = n * halfPeriod + phaseShift for n=0,1,2,3,4
// n=0: t=0 (rising)
// n=1: t=0.5ms (falling)
// n=2: t=1ms (rising)
// n=3: t=1.5ms (falling)
// n=4: t=2ms (rising)

console.log("\nEdges and their breakpoints:");
for (let n = 0; n <= 4; n++) {
  const tEdge = n * halfPeriod + phaseShift;
  const transitionTime = (n % 2 === 0) ? riseTime : fallTime;
  const bpStart = tEdge - transitionTime / 2;
  const bpEnd = tEdge + transitionTime / 2;
  console.log(
    `n=${n}: edge=${tEdge.toExponential(2)}, start=${bpStart.toExponential(2)}, end=${bpEnd.toExponential(2)}`
  );
}

console.log("\nBreakpoints in (0, 0.002]:");
const breakpoints: number[] = [];
for (let n = 0; n <= 4; n++) {
  const tEdge = n * halfPeriod + phaseShift;
  const transitionTime = (n % 2 === 0) ? riseTime : fallTime;
  const bpStart = tEdge - transitionTime / 2;
  const bpEnd = tEdge + transitionTime / 2;
  
  if (bpStart > 0 && bpStart < 0.002) {
    breakpoints.push(bpStart);
    console.log(`  ${breakpoints.length}: ${bpStart.toExponential(10)}`);
  }
  if (bpEnd > 0 && bpEnd < 0.002) {
    breakpoints.push(bpEnd);
    console.log(`  ${breakpoints.length}: ${bpEnd.toExponential(10)}`);
  }
}

console.log(`\nTotal breakpoints: ${breakpoints.length}`);
console.log("Breakpoints:", breakpoints.map(bp => bp.toExponential(10)));
