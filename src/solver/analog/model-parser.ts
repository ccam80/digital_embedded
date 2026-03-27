/**
 * SPICE .MODEL statement parser.
 *
 * Parses standard SPICE .MODEL syntax into structured DeviceModel records.
 * Supports multi-line continuations (+ prefix), inline comments (* or ;),
 * parenthesized or bare parameter lists, scientific notation, and SPICE
 * multiplier suffixes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// DeviceType is defined in core/analog-types.ts. Imported for local use and
// re-exported for backward compatibility with existing consumers.
import type { DeviceType } from "../../core/analog-types.js";
export type { DeviceType } from "../../core/analog-types.js";

/** A successfully parsed .MODEL record. */
export interface ParsedModel {
  /** Model name (e.g. "1N4148", "2N2222"). */
  name: string;
  /** Device type. */
  deviceType: DeviceType;
  /** Model level (defaults to 1 when not specified). */
  level: number;
  /** Extracted parameter key-value pairs. */
  params: Record<string, number>;
}

/** A parse error with line number and description. */
export interface ParseError {
  /** 1-based line number where the error occurred. */
  line: number;
  /** Human-readable description of the parse failure. */
  message: string;
}

// ---------------------------------------------------------------------------
// SPICE suffix table
// ---------------------------------------------------------------------------

/**
 * SPICE multiplier suffixes (case-insensitive, matched in longest-first order).
 *
 * SPICE suffix table:
 *   T   = 1e12
 *   G   = 1e9
 *   MEG = 1e6
 *   K   = 1e3
 *   M   = 1e-3
 *   U   = 1e-6
 *   N   = 1e-9
 *   P   = 1e-12
 *   F   = 1e-15
 */
const SPICE_SUFFIXES: Array<[string, number]> = [
  ["MEG", 1e6],
  ["T", 1e12],
  ["G", 1e9],
  ["K", 1e3],
  ["M", 1e-3],
  ["U", 1e-6],
  ["N", 1e-9],
  ["P", 1e-12],
  ["F", 1e-15],
];

/**
 * Parse a SPICE numeric value string into a number.
 *
 * Handles:
 * - Standard floating-point: "1.5", "3.14"
 * - Scientific notation: "1e-15", "14.34E-15"
 * - SPICE suffix: "4.7K", "100P", "1.5MEG", "100M"
 */
function parseSpiceValue(raw: string): number {
  const s = raw.trim();
  if (s === "") return NaN;

  // Try plain number first (handles scientific notation too via parseFloat)
  const plain = parseFloat(s);
  if (!isNaN(plain) && plain.toString().length === s.length) {
    return plain;
  }

  // Try suffix: find where the numeric part ends and suffix begins
  // The numeric part is digits, dot, +, -, e, E
  const numericMatch = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
  if (!numericMatch) {
    // Try plain parse as fallback
    return parseFloat(s);
  }

  const numericPart = numericMatch[1];
  const suffix = s.slice(numericPart.length).trim().toUpperCase();

  const base = parseFloat(numericPart);
  if (isNaN(base)) return NaN;

  if (suffix === "") return base;

  for (const [sfx, multiplier] of SPICE_SUFFIXES) {
    if (suffix === sfx || suffix.startsWith(sfx)) {
      return base * multiplier;
    }
  }

  // Unknown suffix — return NaN to signal parse failure
  return NaN;
}

// ---------------------------------------------------------------------------
// VALID_DEVICE_TYPES set
// ---------------------------------------------------------------------------

const VALID_DEVICE_TYPES = new Set<string>([
  "NPN", "PNP", "NMOS", "PMOS", "NJFET", "PJFET", "D",
]);

// ---------------------------------------------------------------------------
// Internal: parse parameter tokens
// ---------------------------------------------------------------------------

/**
 * Parse a block of text containing KEY=VALUE pairs (possibly space-separated,
 * possibly with parentheses stripped) into a params record.
 *
 * Handles: "IS=1e-14 N=1 RS=0" and "(IS=1e-14 N=1 RS=0)"
 */
function parseParamBlock(block: string): Record<string, number> {
  // Strip surrounding parentheses if present
  const stripped = block.replace(/^\s*\(/, "").replace(/\)\s*$/, "").trim();

  const params: Record<string, number> = {};

  // Match KEY=VALUE pairs (KEY is alphanumeric + underscore, VALUE is a SPICE value)
  const paramPattern = /([A-Za-z_][A-Za-z0-9_]*)=([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[A-Za-z]*)/g;
  let match: RegExpExecArray | null;

  while ((match = paramPattern.exec(stripped)) !== null) {
    const key = match[1].toUpperCase();
    const val = parseSpiceValue(match[2]);
    if (!isNaN(val)) {
      params[key] = val;
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// parseModelCard — single .MODEL statement
// ---------------------------------------------------------------------------

/**
 * Parse a single `.MODEL` statement (possibly spanning multiple lines via
 * continuation) into a `ParsedModel`, or return a `ParseError`.
 *
 * @param text - The raw text of one `.MODEL` block (may contain newlines and
 *               `+` continuation lines already joined, or a single line).
 * @param startLine - The 1-based line number where this block starts (used
 *                    in `ParseError.line`).
 */
export function parseModelCard(
  text: string,
  startLine = 1,
): ParsedModel | ParseError {
  // Normalize: join continuation lines (lines starting with +)
  const joined = joinContinuationLines(text);

  // Strip inline comments (;...) — * comments are full-line and handled by joinContinuationLines
  const noComments = joined.replace(/;[^\n]*/g, "");

  // Extract the .MODEL keyword line
  // Pattern: .MODEL <name> <type> [optional param block]
  const modelMatch = noComments.match(
    /\.MODEL\s+(\S+)\s+(\S+)([\s\S]*)/i,
  );

  if (!modelMatch) {
    return {
      line: startLine,
      message: `.MODEL statement is missing required fields (name and device type). Got: ${text.trim()}`,
    };
  }

  const name = modelMatch[1];
  const typeStr = modelMatch[2].toUpperCase();
  const rest = modelMatch[3] ?? "";

  if (!VALID_DEVICE_TYPES.has(typeStr)) {
    return {
      line: startLine,
      message: `Unknown device type "${typeStr}" in .MODEL statement. Valid types: ${[...VALID_DEVICE_TYPES].join(", ")}`,
    };
  }

  const deviceType = typeStr as DeviceType;

  // Parse parameters from the remainder
  const params = parseParamBlock(rest);

  // Extract LEVEL parameter (case-insensitive) — default is 1
  const level = params["LEVEL"] !== undefined ? params["LEVEL"] : 1;

  delete params["LEVEL"];

  return { name, deviceType, level, params };
}

// ---------------------------------------------------------------------------
// Internal: join continuation lines and strip full-line comments
// ---------------------------------------------------------------------------

/**
 * Join SPICE continuation lines (lines starting with `+` after stripping
 * leading whitespace) into a single line. Also strips full-line `*` comments.
 */
function joinContinuationLines(text: string): string {
  const lines = text.split("\n");
  const parts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Full-line comments starting with * or ;
    if (trimmed.startsWith("*") || trimmed.startsWith(";")) continue;
    // Continuation line starting with +
    if (trimmed.startsWith("+")) {
      parts.push(" " + trimmed.slice(1).trim());
    } else {
      parts.push(trimmed);
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// parseModelFile — multiple .MODEL statements in a file
// ---------------------------------------------------------------------------

/**
 * Parse a SPICE file (or text block) containing zero or more `.MODEL`
 * statements. Returns all successfully parsed models and all errors.
 *
 * Each `.MODEL` block is delimited by the next `.MODEL` keyword or end of
 * text. Continuation lines (`+`) and full-line comments (`*`) are handled
 * per the single-card parser.
 */
export function parseModelFile(
  text: string,
): { models: ParsedModel[]; errors: ParseError[] } {
  const models: ParsedModel[] = [];
  const errors: ParseError[] = [];

  // Split into logical blocks: each starts with a .MODEL line
  // We track line numbers for error reporting
  const rawLines = text.split("\n");

  // Collect blocks: each block is a contiguous run of lines belonging to
  // one .MODEL statement (the .MODEL line + any following + continuation lines
  // and comment lines before the next .MODEL or non-continuation line).
  //
  // Algorithm:
  //   - Scan for lines that start with .MODEL (case-insensitive)
  //   - Everything until the next .MODEL start belongs to the current block
  //   - Continuation lines (+) and comment lines (*) are part of the block

  type Block = { startLine: number; lines: string[] };
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (/^\.MODEL\b/i.test(trimmed)) {
      // Start a new block
      current = { startLine: i + 1, lines: [line] };
      blocks.push(current);
    } else if (current !== null) {
      // Continuation, comment, or param-only lines belong to the current block
      if (
        trimmed.startsWith("+") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith(";") ||
        trimmed === ""
      ) {
        current.lines.push(line);
      } else {
        // Non-continuation, non-comment line ends the current block
        current = null;
      }
    }
  }

  // Parse each block
  for (const block of blocks) {
    const blockText = block.lines.join("\n");
    const result = parseModelCard(blockText, block.startLine);
    if ("message" in result) {
      errors.push(result);
    } else {
      models.push(result);
    }
  }

  return { models, errors };
}
