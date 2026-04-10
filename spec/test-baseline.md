# Test Baseline
- **Timestamp**: 2026-04-10T00:00:00Z
- **Phase**: Harness Redesign Wave 1 about to start
- **Command**: npm run test:q
- **Result**: 8696/8717 passing, 21 failing (10 Vitest + 11 Playwright), 0 errors
- **Duration**: 219.1s (Vitest 13.5s, Playwright 205.6s)

## Failing Tests (pre-existing)

### Vitest — Engine / BJT convergence (out of scope: known model divergence)
| Test | Status | Summary |
|------|--------|---------|
| src/solver/__tests__/coordinator.ts: "transient stepping does not error after 50 steps" | FAIL | Engine ERROR state at 1ns — BJT convergence baseline |
| src/solver/analog/__tests__/buckbjt-convergence.test.ts — stagnation test | FAIL | BJT stagnation at 1ns |
| src/solver/analog/__tests__/buckbjt-convergence.test.ts — ERROR state test | FAIL | BJT ERROR state at 1ns |
| src/solver/analog/__tests__/buckbjt-mcp-surface.test.ts: "50 steps advance simTime > 0 without ERROR" | FAIL | Same BJT baseline via MCP surface |

### Vitest — Harness self-compare (Wave 3 target via Goal F index alignment)
| Test | Status | Summary |
|------|--------|---------|
| src/solver/analog/__tests__/harness/query-methods.test.ts: "41. Self-comparison: all matrix entries" | FAIL | NaN mismatch from time-based alignment collision; Wave 3 fixes via index pairing + self-compare clone |
| src/solver/analog/__tests__/harness/query-methods.test.ts: "54. traceNode with onlyDivergences" | FAIL | Iteration count 6 vs 0; Wave 3 fixes |

### Vitest — Stream verification (Wave 3 target)
| Test | Status | Summary |
|------|--------|---------|
| src/solver/analog/__tests__/harness/stream-verification.test.ts: "4. integration coefficients: ag0 non-zero" | FAIL | Missing integration coefficient data on tranFloat; Wave 3 `init()` rewrite may fix classification |
| src/solver/analog/__tests__/harness/stream-verification.test.ts: "5. integration coefficients: method transitions to trapezoidal" | FAIL | Same family as test 4 |

### Vitest — MCP harness tools (Wave 3 target)
| Test | Status | Summary |
|------|--------|---------|
| scripts/mcp/__tests__/harness-mcp-verification.test.ts: "MCP-4: integration coefficients" | FAIL | Same family as stream-verif 4/5 |
| scripts/mcp/__tests__/harness-mcp-verification.test.ts: "MCP-5: convergence detail per-element" | FAIL | Already fixed in Round 3 carry-over; verify after Wave 3 |

### Playwright — GUI status (out of scope for harness redesign)
| Test | Status | Summary |
|------|--------|---------|
| e2e/gui/component-sweep.spec.ts — DAC bits property | FAIL | Unrelated: DAC/ADC bits property setting |
| e2e/gui/component-sweep.spec.ts — DAC (2nd test) | FAIL | Unrelated |
| e2e/gui/component-sweep.spec.ts — ADC bits (1) | FAIL | Unrelated |
| e2e/gui/component-sweep.spec.ts — ADC bits (2) | FAIL | Unrelated |
| e2e/gui/master-circuit-assembly.spec.ts: "Master 1 digital logic" | FAIL | Unrelated |

### Playwright — Numerical / performance (out of scope)
| Test | Status | Summary |
|------|--------|---------|
| e2e/parity/analog-bjt-convergence.spec.ts — voltage accuracy | FAIL | BJT baseline |
| e2e/parity/analog-bjt-convergence.spec.ts — transient evolution | FAIL | BJT baseline |
| e2e/parity/hotload-params-e2e.spec.ts: "BJT BF parameter hotload" | FAIL | BJT baseline |
| e2e/parity/stepping-perf.spec.ts — advancement test | FAIL | Performance / advancement |
| e2e/parity/stepping-perf.spec.ts — second perf test | FAIL | Performance / advancement |

## Implementer guidance

Before investigating any test failure:
1. Check this file — if the failing test is listed here, it is pre-existing and **not caused by your changes**.
2. The Wave 3 targets (6 tests) are EXPECTED to start passing after Wave 3 lands. If they still fail at Wave 3 exit, that's a Wave 3 bug.
3. The BJT convergence tests (1-4, plus the Playwright BJT parity tests) are out of scope for the harness redesign — they will remain failing and must not be "fixed" by harness changes.
4. The Playwright GUI tests (DAC/ADC/Master) are unrelated to the harness redesign.

Raw details in `test-results/test-failures.json`.
