import { it } from "vitest";

import { createDefaultRegistry } from "../../../components/register-all.js";

it("dump audit error", () => {
  try {
    createDefaultRegistry();
    console.log("AUDIT_PASSED");
  } catch (e) {
    console.log("AUDIT_ERROR:\n" + (e as Error).message);
  }
});
