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

import type { DeviceType } from "../../core/analog-types.js";

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

/** A single element line parsed from inside a .SUBCKT block. */
export interface ParsedElement {
  /** Instance name (e.g. R1, M1, Q1, X1). */
  name: string;
  /** Element type derived from the first character of the name. */
  type: "R" | "C" | "L" | "D" | "Q" | "M" | "J" | "X" | "V" | "I";
  /** Node names (positional, excluding the instance name). */
  nodes: string[];
  /** Numeric value for passive elements (R/C/L) and sources (V/I). */
  value?: number;
  /** Model reference name for active devices (D/Q/M/J) and subcircuits (X). */
  modelName?: string;
  /** Keyword parameters (W=10u L=1u etc.) for elements that carry them. */
  params?: Record<string, number>;
}

/** The result of parsing a complete .SUBCKT…ENDS block. */
export interface ParsedSubcircuit {
  /** Subcircuit name from the .SUBCKT header. */
  name: string;
  /** External port names in order (as declared on the .SUBCKT line). */
  ports: string[];
  /** All element lines inside the block. */
  elements: ParsedElement[];
  /** Inline .MODEL statements found inside the block. */
  models: ParsedModel[];
  /** .PARAM default values found inside the block. */
  params: Record<string, number>;
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
  // Handle TYPE(params) where type and opening paren are not space-separated
  const typeToken = modelMatch[2];
  const parenIdx = typeToken.indexOf("(");
  const typeStr = (parenIdx !== -1 ? typeToken.slice(0, parenIdx) : typeToken).toUpperCase();
  const rest = parenIdx !== -1
    ? typeToken.slice(parenIdx) + " " + (modelMatch[3] ?? "")
    : (modelMatch[3] ?? "");

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

// ---------------------------------------------------------------------------
// Element type constants
// ---------------------------------------------------------------------------

const VALID_ELEMENT_PREFIXES = new Set<string>([
  "R", "C", "L", "D", "Q", "M", "J", "X", "V", "I",
]);

// ---------------------------------------------------------------------------
// Internal: parse a single element line
// ---------------------------------------------------------------------------

/**
 * Parse a single SPICE element line (non-directive, non-comment) into a
 * `ParsedElement`.  Returns null if the line cannot be recognised.
 *
 * Node-count rules by type:
 *   R, C, L  → 2 nodes  + numeric value (3rd token)
 *   D        → 2 nodes  + model name
 *   Q        → 3 nodes  + model name  (c b e [substrate])
 *   M        → 4 nodes  + model name  + optional KEY=VALUE params
 *   J        → 3 nodes  + model name  (d g s)
 *   V, I     → 2 nodes  + optional value token ("DC 5" or plain "5")
 *   X        → variable nodes + model name (last non-KEY=VALUE token)
 */
function parseElementLine(line: string): ParsedElement | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  const name = tokens[0].toUpperCase();
  const prefix = name[0];

  if (!VALID_ELEMENT_PREFIXES.has(prefix)) return null;

  const type = prefix as ParsedElement["type"];

  // Separate key=value parameter tokens from positional tokens
  const positional: string[] = [];
  const params: Record<string, number> = {};

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      const eqIdx = tok.indexOf("=");
      const key = tok.slice(0, eqIdx).toUpperCase();
      const val = parseSpiceValue(tok.slice(eqIdx + 1));
      if (!isNaN(val)) params[key] = val;
    } else {
      positional.push(tok);
    }
  }

  const hasParams = Object.keys(params).length > 0;

  switch (type) {
    case "R":
    case "C":
    case "L": {
      if (positional.length < 3) return null;
      const value = parseSpiceValue(positional[2]);
      const element: ParsedElement = {
        name,
        type,
        nodes: [positional[0], positional[1]],
        value: isNaN(value) ? undefined : value,
      };
      if (hasParams) element.params = params;
      return element;
    }

    case "D": {
      if (positional.length < 3) return null;
      const element: ParsedElement = {
        name,
        type,
        nodes: [positional[0], positional[1]],
        modelName: positional[2].toUpperCase(),
      };
      if (hasParams) element.params = params;
      return element;
    }

    case "Q": {
      // Q: collector base emitter [substrate] modelName
      if (positional.length < 4) return null;
      const modelName = positional[positional.length - 1].toUpperCase();
      const nodes = positional.slice(0, positional.length - 1);
      const element: ParsedElement = {
        name,
        type,
        nodes,
        modelName,
      };
      if (hasParams) element.params = params;
      return element;
    }

    case "M": {
      // M: drain gate source bulk modelName [params]
      if (positional.length < 5) return null;
      const modelName = positional[4].toUpperCase();
      const element: ParsedElement = {
        name,
        type,
        nodes: [positional[0], positional[1], positional[2], positional[3]],
        modelName,
      };
      if (hasParams) element.params = params;
      return element;
    }

    case "J": {
      // J: drain gate source modelName
      if (positional.length < 4) return null;
      const modelName = positional[3].toUpperCase();
      const element: ParsedElement = {
        name,
        type,
        nodes: [positional[0], positional[1], positional[2]],
        modelName,
      };
      if (hasParams) element.params = params;
      return element;
    }

    case "V":
    case "I": {
      if (positional.length < 2) return null;
      // Accept "V1 p n DC 5", "V1 p n 5", "V1 p n"
      let value: number | undefined;
      // Skip a leading "DC" or "AC" keyword token
      const valueTokenIdx = positional.length > 2
        ? (/^(DC|AC)$/i.test(positional[2]) ? 3 : 2)
        : -1;
      if (valueTokenIdx >= 0 && valueTokenIdx < positional.length) {
        const parsed = parseSpiceValue(positional[valueTokenIdx]);
        if (!isNaN(parsed)) value = parsed;
      }
      const element: ParsedElement = {
        name,
        type,
        nodes: [positional[0], positional[1]],
        value,
      };
      if (hasParams) element.params = params;
      return element;
    }

    case "X": {
      // X: node1 [node2...] subcktName [params]
      // The last positional token is the subcircuit model name
      if (positional.length < 2) return null;
      const modelName = positional[positional.length - 1].toUpperCase();
      const nodes = positional.slice(0, positional.length - 1);
      const element: ParsedElement = {
        name,
        type,
        nodes,
        modelName,
      };
      if (hasParams) element.params = params;
      return element;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// parseSubcircuit — parse a .SUBCKT…ENDS block
// ---------------------------------------------------------------------------

/**
 * Parse a SPICE `.SUBCKT`…`.ENDS` block into a `ParsedSubcircuit`.
 *
 * Throws a `ParseError`-shaped object (with `line` and `message`) when the
 * block is structurally invalid (missing `.ENDS`, no ports declared, or
 * unknown element prefix on a non-directive line).  Individual element lines
 * that cannot be parsed are skipped rather than thrown.
 */
export function parseSubcircuit(text: string): ParsedSubcircuit {
  const rawLines = text.split("\n");

  let subcktHeaderLine = -1;
  let endsLine = -1;
  let subcktName = "";
  const ports: string[] = [];
  const elements: ParsedElement[] = [];
  const models: ParsedModel[] = [];
  const params: Record<string, number> = {};

  // Collect .MODEL blocks inside the subcircuit for multi-line continuation
  // support (identical logic to parseModelFile but scoped to this block).
  type ModelBlock = { startLine: number; lines: string[] };
  let currentModelBlock: ModelBlock | null = null;
  const modelBlocks: ModelBlock[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    const lineNo = i + 1; // 1-based

    // Skip full-line comments and blank lines
    if (trimmed === "" || trimmed.startsWith("*") || trimmed.startsWith(";")) {
      if (currentModelBlock) currentModelBlock.lines.push(raw);
      continue;
    }

    // Continuation lines inside a .MODEL block
    if (trimmed.startsWith("+")) {
      if (currentModelBlock) currentModelBlock.lines.push(raw);
      continue;
    }

    const upper = trimmed.toUpperCase();

    // .SUBCKT header
    if (upper.startsWith(".SUBCKT")) {
      if (subcktHeaderLine !== -1) {
        throw { line: lineNo, message: "Nested .SUBCKT is not supported." };
      }
      subcktHeaderLine = lineNo;
      currentModelBlock = null;
      const headerTokens = trimmed.split(/\s+/);
      if (headerTokens.length < 3) {
        throw {
          line: lineNo,
          message: ".SUBCKT line must have a name and at least one port.",
        };
      }
      subcktName = headerTokens[1];
      for (let t = 2; t < headerTokens.length; t++) {
        ports.push(headerTokens[t]);
      }
      continue;
    }

    // .ENDS — end of subcircuit
    if (upper.startsWith(".ENDS")) {
      endsLine = lineNo;
      currentModelBlock = null;
      break;
    }

    // Only process body lines after the .SUBCKT header
    if (subcktHeaderLine === -1) continue;

    // .MODEL inside the body
    if (upper.startsWith(".MODEL")) {
      currentModelBlock = { startLine: lineNo, lines: [raw] };
      modelBlocks.push(currentModelBlock);
      continue;
    }

    // Close any open .MODEL block when we hit a non-continuation, non-comment
    // non-blank line that is not itself a directive continuation
    currentModelBlock = null;

    // .PARAM line: .PARAM key=value [key=value ...]
    if (upper.startsWith(".PARAM")) {
      const rest = trimmed.slice(".PARAM".length);
      const paramPattern = /([A-Za-z_][A-Za-z0-9_]*)=([^\s=]+)/g;
      let m: RegExpExecArray | null;
      while ((m = paramPattern.exec(rest)) !== null) {
        const val = parseSpiceValue(m[2]);
        if (!isNaN(val)) params[m[1].toUpperCase()] = val;
      }
      continue;
    }

    // Skip other directives (lines starting with .)
    if (trimmed.startsWith(".")) continue;

    // Element line
    const prefix = trimmed[0].toUpperCase();
    if (!VALID_ELEMENT_PREFIXES.has(prefix)) {
      throw {
        line: lineNo,
        message: `Unknown element prefix "${prefix}" on line: ${trimmed}`,
      };
    }

    const parsed = parseElementLine(trimmed);
    if (parsed !== null) {
      elements.push(parsed);
    }
  }

  // Validate structural requirements
  if (subcktHeaderLine === -1) {
    throw { line: 1, message: "No .SUBCKT statement found." };
  }
  if (ports.length === 0) {
    throw { line: subcktHeaderLine, message: ".SUBCKT declares no ports." };
  }
  if (endsLine === -1) {
    throw { line: rawLines.length, message: "Missing .ENDS statement." };
  }

  // Parse collected .MODEL blocks
  for (const block of modelBlocks) {
    const blockText = block.lines.join("\n");
    const result = parseModelCard(blockText, block.startLine);
    if (!("message" in result)) {
      models.push(result);
    }
  }

  return { name: subcktName, ports, elements, models, params };
}
