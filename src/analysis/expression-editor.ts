/**
 * Expression editor tab for the analysis dialog.
 *
 * Allows users to type boolean expressions, parse them, validate them, and
 * convert them into truth tables. Supports variable auto-detection.
 *
 * The ExpressionEditorTab is a pure data/logic class — no DOM dependency.
 * The host (dialog) calls methods to drive it; a thin UI adapter wires it
 * to actual input elements.
 */

import { type BoolExpr, evaluate } from './expression.js';
import { parseExpression, ParseError } from './expression-parser.js';
import { TruthTable, type SignalSpec, type TernaryValue } from './truth-table.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParseResult {
  /** The parsed expression, or null if parsing failed. */
  expr: BoolExpr | null;
  /** Error message with position, or null if parsing succeeded. */
  error: string | null;
  /** 0-based character position of error, or -1 if no error. */
  errorPosition: number;
}

export type ExpressionEditorChangeListener = (result: ParseResult) => void;

// ---------------------------------------------------------------------------
// ExpressionEditorTab
// ---------------------------------------------------------------------------

/**
 * Controller for the expression-editor tab.
 *
 * Lifecycle:
 *   1. Create with optional initial expression text.
 *   2. Call setText() when the user edits the input.
 *   3. Call parse() to validate and build the AST.
 *   4. Call toTruthTable() to evaluate the expression for all variable
 *      combinations and produce a TruthTable.
 */
export class ExpressionEditorTab {
  private _text: string;
  private _lastResult: ParseResult;
  private readonly _listeners = new Set<ExpressionEditorChangeListener>();

  constructor(initialText = '') {
    this._text = initialText;
    this._lastResult = { expr: null, error: null, errorPosition: -1 };
  }

  /** Current expression text. */
  get text(): string {
    return this._text;
  }

  /** Result of the most recent parse() call. */
  get lastResult(): ParseResult {
    return this._lastResult;
  }

  /** Update the expression text (does not automatically re-parse). */
  setText(text: string): void {
    this._text = text;
  }

  /**
   * Parse the current text.
   *
   * Fires change listeners with the result. Returns the ParseResult so
   * callers can inspect it synchronously.
   */
  parse(): ParseResult {
    let result: ParseResult;
    try {
      const expr = parseExpression(this._text);
      result = { expr, error: null, errorPosition: -1 };
    } catch (err) {
      if (err instanceof ParseError) {
        result = { expr: null, error: err.message, errorPosition: err.position };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        result = { expr: null, error: msg, errorPosition: -1 };
      }
    }
    this._lastResult = result;
    this._emit(result);
    return result;
  }

  /**
   * Detect variable names used in the expression (sorted alphabetically).
   *
   * Re-uses the last successful parse result if available and current,
   * otherwise re-parses.
   */
  detectVariables(): string[] {
    let expr = this._lastResult.expr;
    if (expr === null) {
      const result = this.parse();
      expr = result.expr;
    }
    if (expr === null) return [];
    const vars = new Set<string>();
    collectVariables(expr, vars);
    return [...vars].sort();
  }

  /**
   * Evaluate the expression for all combinations of detected variables and
   * return a TruthTable.
   *
   * @param outputName  Name of the output signal (defaults to 'Y').
   * @returns           A TruthTable with one row per input combination.
   * @throws            ParseError if the expression text cannot be parsed.
   * @throws            Error if the expression has no variables (constants
   *                    produce a 0-row table; the method handles them gracefully).
   */
  toTruthTable(outputName = 'Y'): TruthTable {
    // Parse if needed
    let expr = this._lastResult.expr;
    if (expr === null) {
      const result = this.parse();
      if (result.expr === null) {
        throw new Error(result.error ?? 'Parse failed');
      }
      expr = result.expr;
    }

    const varNames = (() => {
      const vars = new Set<string>();
      collectVariables(expr!, vars);
      return [...vars].sort();
    })();

    // Build truth table inputs (one single-bit input per variable)
    const inputs: SignalSpec[] = varNames.map((name) => ({ name, bitWidth: 1 }));
    const outputs: SignalSpec[] = [{ name: outputName, bitWidth: 1 }];

    const numVars = varNames.length;
    const rowCount = 1 << numVars;
    const data: TernaryValue[] = [];

    for (let row = 0; row < rowCount; row++) {
      const env = new Map<string, boolean>();
      for (let v = 0; v < numVars; v++) {
        // Variable 0 is MSB: bit (numVars - 1 - v) of row
        env.set(varNames[v]!, Boolean((row >> (numVars - 1 - v)) & 1));
      }
      const result = evaluate(expr!, env);
      data.push(result ? 1n : 0n);
    }

    return new TruthTable(inputs, outputs, data);
  }

  addChangeListener(listener: ExpressionEditorChangeListener): void {
    this._listeners.add(listener);
  }

  removeChangeListener(listener: ExpressionEditorChangeListener): void {
    this._listeners.delete(listener);
  }

  private _emit(result: ParseResult): void {
    for (const listener of this._listeners) {
      listener(result);
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function collectVariables(expr: BoolExpr, out: Set<string>): void {
  switch (expr.kind) {
    case 'variable':
      out.add(expr.name);
      break;
    case 'not':
      collectVariables(expr.operand, out);
      break;
    case 'and':
    case 'or':
      for (const op of expr.operands) collectVariables(op, out);
      break;
    case 'constant':
      break;
  }
}
