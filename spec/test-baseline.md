# Test Baseline

- **Timestamp**: 2026-04-28T17:45:00Z
- **Phase**: 3.5 (W3.5 Component Spec Gaps)
- **Command**: `npm run test:q` (vitest run --reporter=verbose)
- **Result**: 8294/9438 passing, 1144 failing, 0 errors

## Summary

The test suite includes unit/integration tests (vitest) and was executed during the W3.5 component spec gaps phase. Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", this baseline is **informational only** — implementers and verifiers in W3.5 do NOT consult test results for verification decisions. Verification is strictly **spec compliance** against the PB-*.md spec contract and cited ngspice anchor files.

## Pre-existing Failures (Sample)

The failing tests include:

| Test File | Test Count | Categories |
|-----------|-----------|------------|
| src/editor/__tests__/wire-current-resolver.test.ts | 4 | Wire current resolution (KCL conservation) |
| src/components/passives/__tests__/transmission-line.test.ts | 14 | Transmission line parameters, loss, reflection |
| src/components/semiconductors/__tests__/diode.test.ts | 3 | Diode DC OP, parameter sensitivity |
| src/solver/analog/__tests__/dc-operating-point.test.ts | 6 | DC operating point, Gmin stepping, convergence |
| src/solver/analog/__tests__/sparse-solver.test.ts | 1 | MNA matrix structure performance |
| src/components/semiconductors/__tests__/mosfet.test.ts | 4+ | MOSFET biasing regions, nonlinear stamps |
| src/components/active/__tests__/vccs.test.ts | 4 | VCCS setup method not found (W3 migration) |
| src/components/active/__tests__/vcvs.test.ts | 5 | VCVS setup method not found (W3 migration) |
| src/solver/analog/__tests__/ngspice-parity/*.test.ts | 15+ | Matrix structural divergence (A1 MNA-layout errors) |
| src/headless/__tests__/rc-rl-diagnostic.test.ts | 2 | State undefined (engine setup incomplete) |

### Key Patterns

1. **W3 Migration Setup Method Failures** (VCCS, VCVS, etc.): `el.setup is not a function` — components awaiting W3 implementation per the setup-load-split plan.

2. **Matrix Structural Divergence (A1 MNA-layout)**: Multiple parity tests report `matrixSize = 0 (ours) vs 5-7 (ngspice)`. This is a known pre-W3 state — setup() bodies are stubs, so no equations are allocated.

3. **State Undefined**: Some diagnostic tests fail with `Cannot read properties of undefined (reading 'states')` — indicates engine state not fully initialized post-setup.

4. **Transmission Line & Wire Current Tests**: These test components whose setup() and load() bodies are under W3.5 implementation scope.

5. **Xfact Scope Audit Failures**: Stale allowlist entries and unguarded reads in `mosfet.ts:1480`.

## Notes

- Tests were run **without E2E (Playwright)** due to process timeout on full `npm run test:q`. The unit/integration vitest suite completed successfully.
- Per project policy, these failures are **expected during W3/W3.5** because stub setup() methods throw or remain incomplete.
- Implementer/verifier decisions are based on **spec compliance**, not test pass/fail status during the migration.
- Full test suite (including E2E) can be run post-W3.5 once all setup() bodies are implemented and the engine is fully initialized.
