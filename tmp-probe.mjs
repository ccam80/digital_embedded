import { computeNIcomCof } from "./src/solver/analog/integration.js";
const h = 1e-6;
const ag = new Float64Array(8);
const scratch = new Float64Array(49);
computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);
for (let i = 0; i < 5; i++) {
  console.log(`ag[${i}] =`, ag[i], " hex =", ag[i].toString(16));
}
