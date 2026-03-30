# Test Baseline

- **Timestamp**: 2026-03-31T00:00:00Z
- **Phase**: Wave 3+4 (Runtime Features + Verification)
- **Command**: `npm run test:q`
- **Result**: 9731/9868 passing, 137 failing, 0 errors

## Test Summary

- **Total tests**: 9868 (9731 passing, 137 failing)
- **Duration**: 13.9 seconds
- **Total test files**: 332

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| port-analog-mixed.test.ts::Port label appears in readAllSignals() for a pure analog circuit | FAIL | Voltage assertion: expected 0 to be greater than 4.9 |
| port-analog-mixed.test.ts::readOutput() via Port label works in a pure analog circuit | FAIL | Voltage assertion: expected 0 to be greater than 4.9 |
| spice-model-apply.ts::applySpiceImportResult writes to circuit.metadata.namedParameterSets (13 tests) | FAIL | applySpiceImportResult: pending reimplementation with unified model system |
| spice-model-overrides-mcp.test.ts::patch with _spiceModelOverrides changes DC operating point vs default | FAIL | Assertion: expected false to be true |
| coordinator-capability.test.ts::snapshotSignals contains non-zero voltages after DC op | FAIL | Assertion: expected false to be true |
| coordinator-slider-snapshot.test.ts::returns finite number for element index 0 | FAIL | Assertion: expected false to be true |
| coordinator-visualization.test.ts::voltage source pins span a non-zero potential after DC op (4 tests) | FAIL | Voltage range assertions failing (expected > 0, got 0) |
| properties.ts::forward_bias_stamp (7 PropertyBag tests) | FAIL | PropertyBag: model param "BV" not found |
| mosfet.test.ts::common_source_nmos | FAIL | Assertion: expected 0.00041832669322709216 to be greater than 0.0005 |
| properties.ts::blocks_without_gate (2 SCR/TRIAC tests) | FAIL | PropertyBag: model param "vOn" not found |
| ldr.test.ts::LDRDefinition has engine type analog (6 tests) | FAIL | Assertion: expected undefined to be defined |
| properties.ts::analogFactory creates an LDRElement | FAIL | PropertyBag: model param "rDark" not found |
| properties.ts::analogFactory creates an NTCThermistorElement | FAIL | PropertyBag: model param "r0" not found |
| ac-voltage-source.test.ts::sine_at_t_zero (15 source/factory tests) | FAIL | Cannot read properties of undefined (reading 'behavioral') |
| dc-voltage-source.test.ts::definition_has_requires_branch_row (2 tests) | FAIL | Assertion: expected undefined to be 1 |
| analog-engine.test.ts::runner_integration | FAIL | Assertion: expected +0 to be close to 2.5 |
| mna-end-to-end.test.ts::resistor_divider_dc_op_via_compiler (3 MOSFET tests) | FAIL | Assertion: expected +0 to be close to 5 (MNA solver convergence) |
| compiler.test.ts::compiles_resistor_divider | FAIL | Assertion: expected +0 to be 3 (topology compilation) |
| compiler.test.ts::assigns_ground_node_zero | FAIL | Cannot read properties of undefined (reading 'pinNodeIds') |
| compiler.test.ts::detects_voltage_source_loop | FAIL | Assertion: expected +0 to be 2 |
| compiler.test.ts::calls_analog_factory_with_correct_args | FAIL | Spy assertion: expected spy to be called once, but got 0 times |
| mna-end-to-end.test.ts::diode_circuit_dc_op_via_compiler | FAIL | Assertion: expected 0 to be greater than 0.55 |
| rc-ac-transient.test.ts::compilation produces correct topology | FAIL | Assertion: expected +0 to be 1 |
| rc-ac-transient.test.ts::transient stepping produces time-varying output | FAIL | Assertion: expected 0 to be greater than 0.01 |
| rc-ac-transient.test.ts::full pipeline: compile → DC OP → transient → analytical match | FAIL | Assertion: expected 0 to be greater than 4.5 |
| spice-import-dialog.test.ts::import .MODEL card → store as _spiceModelOverrides → compile applies IS override (4 tests) | FAIL | Diagnostic assertion: expected array length 0 but got 2 (orphan-node errors) |
| spice-import-dialog.test.ts::unmodified params stay at NPN defaults when IS is overridden | FAIL | Cannot read properties of undefined (reading 'IS') |
| spice-import-dialog.test.ts::multiline .MODEL card with continuation is parsed and applied correctly | FAIL | Cannot read properties of undefined (reading 'IS') |
| spice-model-overrides.test.ts::override_merge: IS overridden to 1e-14, other params stay at NPN defaults (4 tests) | FAIL | Diagnostic assertion: expected array length 0 but got 1-2 (orphan-node errors) |
| circuit-mcp-server.test.ts::returns named MNA models for And gate via availableModels | FAIL | availableModels is not a function |
| circuit-mcp-server.test.ts::returns subcircuitRefs on And gate definition | FAIL | Assertion: expected undefined to be defined |

## Root Cause Categories

1. **Analog Solver Not Converging** (25+ tests): MNA compiler/engine not properly initializing or building circuit topology
2. **SPICE Model System Pending** (13 tests): applySpiceImportResult awaiting unified model system implementation
3. **Missing PropertyBag Definitions** (11 tests): Model parameters (BV, vOn, rDark, r0) not registered in PropertyBag
4. **Factory Initialization** (15 tests): AC/DC voltage source and current source behavioral models not being created
5. **Component Definition Metadata** (6 tests): engine type and requires_branch_row properties missing from definitions
6. **MCP Server API Changes** (1 test): availableModels function signature mismatch

## Notes

- **Progress**: Bridge & Hot-Loadable Params work (Waves 1-4) has largely been completed; 40 bridge/pin-loading related failures have been resolved
- **Current blockers**: Solver convergence issues and model system implementation are now primary focus
- **Architectural change**: Factory initialization and behavioral model setup appears to be in transition
- **SPICE integration**: 13 tests blocked on unified model system implementation (planned work)

## Baseline Established

This baseline captures the state after Wave 2 completion with bridge synthesis and model routing features largely resolved. Primary remaining work is in analog solver convergence, factory initialization, and SPICE model system unification.
