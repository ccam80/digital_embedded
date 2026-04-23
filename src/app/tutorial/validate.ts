/**
 * Tutorial manifest validator.
 *
 * Performs structural + semantic validation of a TutorialManifest:
 *   - All required fields present and correctly typed (via type guards)
 *   - Step IDs are unique and URL-safe
 *   - Component type names in palette specs are registered
 *   - Preset names are recognized
 *   - Test data parses without errors
 *   - "carry-forward" is not used on the first step
 *   - Equivalence validation has a goal circuit
 *   - Test-vectors validation has test data
 *   - Circuit specs reference valid component types
 *
 * Returns a flat list of diagnostics (errors + warnings) rather than throwing.
 * This follows the same pattern as circuit netlist diagnostics.
 */

import type { TutorialCircuitSpec, PaletteSpec } from './types.js';
import { isTutorialManifest, isUrlSafeId } from './types.js';
import { PALETTE_PRESETS } from './presets.js';
import type { ComponentRegistry } from '../../core/registry.js';

// ---------------------------------------------------------------------------
// Diagnostic types
// ---------------------------------------------------------------------------

export type TutorialDiagnosticSeverity = 'error' | 'warning';

export interface TutorialDiagnostic {
  severity: TutorialDiagnosticSeverity;
  /** Which step the issue is in, or null for manifest-level issues. */
  stepId: string | null;
  /** Machine-readable code for programmatic handling. */
  code: string;
  /** Human-readable description of the issue. */
  message: string;
  /** Optional fix suggestion. */
  fix?: string;
}

// Diagnostic codes:
// manifest-structure    — top-level structure invalid
// step-structure        — step structure invalid
// duplicate-step-id     — two steps share an ID
// unsafe-id             — ID contains characters that aren't URL-safe
// unknown-component     — component type not in registry
// unknown-preset        — palette preset name not recognized
// carry-forward-first   — "carry-forward" on first step
// missing-test-data     — test-vectors validation without testData
// missing-goal          — equivalence validation without goalCircuit
// test-data-parse-error — testData string fails to parse
// circuit-spec-error    — circuit spec references unknown types

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

/**
 * Validate a TutorialManifest against the component registry.
 *
 * @param manifest  The manifest to validate (raw JSON object or typed).
 * @param registry  Component registry for validating type names.
 * @returns Array of diagnostics. Empty array = valid.
 */
export function validateManifest(
  manifest: unknown,
  registry: ComponentRegistry,
): TutorialDiagnostic[] {
  const diagnostics: TutorialDiagnostic[] = [];

  // Phase 1: Structural type check
  if (!isTutorialManifest(manifest)) {
    diagnostics.push({
      severity: 'error',
      stepId: null,
      code: 'manifest-structure',
      message: 'Manifest does not match the required TutorialManifest structure. '
        + 'Required fields: id (string), version (1), title (string), description (string), '
        + 'difficulty ("beginner"|"intermediate"|"advanced"), steps (non-empty array of TutorialStep).',
      fix: 'Check the TutorialManifest type definition in src/tutorial/types.ts for the exact schema.',
    });
    return diagnostics;
  }

  // Phase 2: Manifest-level checks
  if (!isUrlSafeId(manifest.id)) {
    diagnostics.push({
      severity: 'error',
      stepId: null,
      code: 'unsafe-id',
      message: `Tutorial ID "${manifest.id}" is not URL-safe. Use lowercase alphanumeric characters and hyphens only.`,
      fix: `Try "${manifest.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')}"`,
    });
  }

  // Phase 3: Step-level checks
  const stepIds = new Set<string>();

  for (let i = 0; i < manifest.steps.length; i++) {
    const step = manifest.steps[i]!;
    const stepLabel = `step[${i}] "${step.id}"`;

    // Duplicate IDs
    if (stepIds.has(step.id)) {
      diagnostics.push({
        severity: 'error',
        stepId: step.id,
        code: 'duplicate-step-id',
        message: `Duplicate step ID "${step.id}". Each step must have a unique ID.`,
      });
    }
    stepIds.add(step.id);

    // URL-safe ID
    if (!isUrlSafeId(step.id)) {
      diagnostics.push({
        severity: 'warning',
        stepId: step.id,
        code: 'unsafe-id',
        message: `Step ID "${step.id}" is not URL-safe. Use lowercase alphanumeric characters and hyphens.`,
      });
    }

    // carry-forward on first step
    if (i === 0 && step.startCircuit === 'carry-forward') {
      diagnostics.push({
        severity: 'error',
        stepId: step.id,
        code: 'carry-forward-first',
        message: `${stepLabel}: "carry-forward" cannot be used on the first step (there is no previous step).`,
        fix: 'Use null for an empty canvas, or provide a CircuitSpec or .dig file path.',
      });
    }

    // Validation mode consistency
    const effectiveValidation = step.validation
      ?? (step.testData ? 'test-vectors' : 'manual');

    if (effectiveValidation === 'test-vectors' && !step.testData) {
      diagnostics.push({
        severity: 'error',
        stepId: step.id,
        code: 'missing-test-data',
        message: `${stepLabel}: validation is "test-vectors" but no testData is provided.`,
        fix: 'Add a testData field with Digital test format, or change validation to "manual" or "compile-only".',
      });
    }

    if (effectiveValidation === 'equivalence' && !step.goalCircuit) {
      diagnostics.push({
        severity: 'error',
        stepId: step.id,
        code: 'missing-goal',
        message: `${stepLabel}: validation is "equivalence" but no goalCircuit is provided.`,
        fix: 'Add a goalCircuit field with a CircuitSpec or .dig file path.',
      });
    }

    // Explore mode without goalCircuit — "Show Solution" button won't work
    if (step.mode === 'explore' && !step.goalCircuit) {
      diagnostics.push({
        severity: 'warning',
        stepId: step.id,
        code: 'explore-no-goal',
        message: `${stepLabel}: mode is "explore" but no goalCircuit is provided. The "Show Solution" button will be hidden.`,
        fix: 'Add a goalCircuit field if you want students to be able to view a reference solution.',
      });
    }

    // Test data parsing
    if (step.testData) {
      // validateTestDataSyntax appends to `diagnostics` directly; it does
      // not throw on malformed input. Per spec/architectural-alignment.md
      // §I1 the prior try/catch hid real bugs.
      validateTestDataSyntax(step.testData, step.id, diagnostics);
    }

    // Palette spec validation
    if (step.palette !== null && step.palette !== undefined) {
      validatePaletteSpec(step.palette, step.id, registry, diagnostics);
    }

    // Circuit spec validation
    if (step.startCircuit !== null && step.startCircuit !== 'carry-forward' && typeof step.startCircuit !== 'string') {
      validateCircuitSpec(step.startCircuit, `${stepLabel} startCircuit`, step.id, registry, diagnostics);
    }
    if (step.goalCircuit && typeof step.goalCircuit !== 'string') {
      validateCircuitSpec(step.goalCircuit, `${stepLabel} goalCircuit`, step.id, registry, diagnostics);
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validatePaletteSpec(
  spec: PaletteSpec,
  stepId: string,
  registry: ComponentRegistry,
  diagnostics: TutorialDiagnostic[],
): void {
  if (typeof spec === 'string') {
    // Named preset
    if (!PALETTE_PRESETS.has(spec)) {
      diagnostics.push({
        severity: 'error',
        stepId,
        code: 'unknown-preset',
        message: `Unknown palette preset "${spec}". Available presets: ${Array.from(PALETTE_PRESETS.keys()).join(', ')}.`,
      });
    }
    return;
  }

  if (Array.isArray(spec)) {
    // Explicit list of type names
    for (const name of spec) {
      if (!registry.get(name)) {
        diagnostics.push({
          severity: 'warning',
          stepId,
          code: 'unknown-component',
          message: `Palette component "${name}" is not registered.`,
          fix: `Check spelling. Use circuit_list to see all available component types.`,
        });
      }
    }
    return;
  }

  // Preset with modifications
  if (!PALETTE_PRESETS.has(spec.preset)) {
    diagnostics.push({
      severity: 'error',
      stepId,
      code: 'unknown-preset',
      message: `Unknown palette preset "${spec.preset}". Available: ${Array.from(PALETTE_PRESETS.keys()).join(', ')}.`,
    });
  }
  for (const name of spec.add ?? []) {
    if (!registry.get(name)) {
      diagnostics.push({
        severity: 'warning',
        stepId,
        code: 'unknown-component',
        message: `Palette add component "${name}" is not registered.`,
      });
    }
  }
}

function validateCircuitSpec(
  spec: TutorialCircuitSpec,
  context: string,
  stepId: string,
  registry: ComponentRegistry,
  diagnostics: TutorialDiagnostic[],
): void {
  const specIds = new Set<string>();

  for (const comp of spec.components) {
    if (specIds.has(comp.id)) {
      diagnostics.push({
        severity: 'error',
        stepId,
        code: 'circuit-spec-error',
        message: `${context}: duplicate component ID "${comp.id}".`,
      });
    }
    specIds.add(comp.id);

    if (!registry.get(comp.type)) {
      diagnostics.push({
        severity: 'error',
        stepId,
        code: 'unknown-component',
        message: `${context}: unknown component type "${comp.type}".`,
        fix: 'Use circuit_list or circuit_describe to check available types.',
      });
    }
  }

  // Validate connection references
  for (const [from, to] of spec.connections) {
    const fromId = from.split(':')[0];
    const toId = to.split(':')[0];
    if (fromId && !specIds.has(fromId)) {
      diagnostics.push({
        severity: 'error',
        stepId,
        code: 'circuit-spec-error',
        message: `${context}: connection references unknown component ID "${fromId}" in "${from}".`,
      });
    }
    if (toId && !specIds.has(toId)) {
      diagnostics.push({
        severity: 'error',
        stepId,
        code: 'circuit-spec-error',
        message: `${context}: connection references unknown component ID "${toId}" in "${to}".`,
      });
    }
  }
}

/**
 * Validate test data syntax without importing the parser at module level.
 * This avoids circular dependency issues while still checking parse-ability.
 */
function validateTestDataSyntax(
  testData: string,
  stepId: string,
  diagnostics: TutorialDiagnostic[],
): void {
  // Basic structural checks without importing the full parser
  const lines = testData.split('\n').filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
  if (lines.length === 0) {
    diagnostics.push({
      severity: 'error',
      stepId,
      code: 'test-data-parse-error',
      message: 'Test data is empty (no non-comment, non-blank lines).',
    });
    return;
  }

  // Check header line has at least 2 signal names
  const headerLine = lines[0]!;
  const headerNames = headerLine.trim().split(/\s+/).filter((n) => n.length > 0);
  if (headerNames.length < 2) {
    diagnostics.push({
      severity: 'warning',
      stepId,
      code: 'test-data-parse-error',
      message: 'Test data header has fewer than 2 signal names. Need at least one input and one output.',
      fix: 'Format: "input1 input2 output1 output2" — input/output split is auto-detected from circuit In/Out labels.',
    });
  }
}
