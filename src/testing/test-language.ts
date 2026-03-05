/**
 * CodeMirror 6 language support for Digital's test vector syntax.
 *
 * Provides syntax highlighting tokens for the test data format:
 *   - Comments (#...) → comment style
 *   - Keywords (loop, end loop, repeat, bits, while, let, declare, etc.) → keyword style
 *   - Values (0, 1, X, C, Z, hex literals 0xFF) → atom/value style
 *   - Signal names (header line identifiers) → variableName style
 *
 * This is a stream-based tokenizer (no full parse tree) sufficient for
 * highlighting purposes.
 */

import { StreamLanguage, type StreamParser } from '@codemirror/language';

// ---------------------------------------------------------------------------
// Token type names for highlighting
// ---------------------------------------------------------------------------

/** Token types returned by the stream parser and tokenizeLine utility. */
export type DigitalTestToken =
  | 'comment'
  | 'keyword'
  | 'atom'          // values: 0, 1, X, C, Z, hex literals
  | 'variableName'  // signal names (header line)
  | null;

// ---------------------------------------------------------------------------
// Keywords in Digital test syntax
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'loop', 'end', 'repeat', 'bits', 'while', 'let', 'declare',
  'init', 'memory', 'program', 'resetRandom',
]);

// ---------------------------------------------------------------------------
// State for the stream parser
// ---------------------------------------------------------------------------

interface DigitalTestState {
  /** True while tokenizing the header (first non-comment, non-blank) line. */
  onHeaderLine: boolean;
  /** True once we have finished the header line. */
  headerSeen: boolean;
}

// ---------------------------------------------------------------------------
// StreamParser implementation
// ---------------------------------------------------------------------------

const parser: StreamParser<DigitalTestState> = {
  name: 'digital-test',

  startState(): DigitalTestState {
    return { onHeaderLine: false, headerSeen: false };
  },

  blankLine(_state: DigitalTestState): void {
    // blank lines don't affect state
  },

  token(stream, state): DigitalTestToken {
    // At start of non-blank, non-comment line: if header not yet seen, mark it
    if (stream.sol() && !state.headerSeen) {
      const firstChar = stream.peek();
      if (firstChar !== null && firstChar !== '#' && firstChar.trim() !== '') {
        state.onHeaderLine = true;
      }
    }

    // Whitespace (spaces and tabs only — newlines handled by CodeMirror)
    if (stream.eat(/[ \t]/)) {
      stream.eatWhile(/[ \t]/);
      return null;
    }

    // Comment: # to end of line
    if (stream.peek() === '#') {
      stream.skipToEnd();
      // Comment-only line is not the header
      state.onHeaderLine = false;
      return 'comment';
    }

    // Hex literal: 0x... or 0X...
    if (stream.match(/^0[xX][0-9a-fA-F]+/)) {
      return 'atom';
    }

    // Decimal/binary integer
    if (stream.match(/^[0-9]+/)) {
      return 'atom';
    }

    // Identifier, keyword, or value token (X, C, Z)
    const identMatch = stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (identMatch) {
      const ident = (identMatch as RegExpMatchArray)[0];

      // Single-letter value tokens (case-sensitive per Digital convention)
      if (ident === 'X' || ident === 'C' || ident === 'Z') {
        return 'atom';
      }

      // Keywords
      if (KEYWORDS.has(ident)) {
        return 'keyword';
      }

      // Signal names on the header line
      if (state.onHeaderLine) {
        return 'variableName';
      }

      // Loop variable references and other identifiers after the header
      return 'variableName';
    }

    // End of line: close the header window
    if (stream.eol()) {
      if (state.onHeaderLine) {
        state.onHeaderLine = false;
        state.headerSeen = true;
      }
      return null;
    }

    // Skip unknown characters (operators, punctuation)
    stream.next();
    return null;
  },
};

// ---------------------------------------------------------------------------
// Exported CodeMirror 6 language extension
// ---------------------------------------------------------------------------

/**
 * CodeMirror 6 StreamLanguage for Digital's test vector syntax.
 *
 * Usage:
 *   import { digitalTestLanguage } from './test-language.js';
 *   EditorState.create({ extensions: [digitalTestLanguage] })
 */
export const digitalTestLanguage = StreamLanguage.define(parser);

// ---------------------------------------------------------------------------
// tokenizeLine — standalone utility for testing
// ---------------------------------------------------------------------------

/**
 * Tokenize a single line of Digital test syntax.
 *
 * Returns an array of `{ text, token }` objects where `token` is the
 * DigitalTestToken classification. Whitespace tokens are omitted.
 *
 * @param line      The source line to tokenize (no newline at end)
 * @param isHeader  True if this line is the header (signal names) line
 */
export function tokenizeLine(
  line: string,
  isHeader: boolean,
): Array<{ text: string; token: DigitalTestToken }> {
  const result: Array<{ text: string; token: DigitalTestToken }> = [];
  let pos = 0;

  function readWhile(pred: (ch: string) => boolean): string {
    let s = '';
    while (pos < line.length && pred(line[pos])) {
      s += line[pos++];
    }
    return s;
  }

  while (pos < line.length) {
    const ch = line[pos];

    // Whitespace — skip silently
    if (ch === ' ' || ch === '\t') {
      readWhile((c) => c === ' ' || c === '\t');
      continue;
    }

    // Comment: rest of line
    if (ch === '#') {
      const text = line.slice(pos);
      pos = line.length;
      result.push({ text, token: 'comment' });
      continue;
    }

    // Hex literal: 0x...
    if (ch === '0' && pos + 1 < line.length && (line[pos + 1] === 'x' || line[pos + 1] === 'X')) {
      const start = pos;
      pos += 2; // consume "0x"
      readWhile((c) => /[0-9a-fA-F]/.test(c));
      result.push({ text: line.slice(start, pos), token: 'atom' });
      continue;
    }

    // Decimal integer
    if (/[0-9]/.test(ch)) {
      const start = pos;
      readWhile((c) => /[0-9]/.test(c));
      result.push({ text: line.slice(start, pos), token: 'atom' });
      continue;
    }

    // Identifier, keyword, or value token
    if (/[a-zA-Z_]/.test(ch)) {
      const start = pos;
      readWhile((c) => /[a-zA-Z0-9_]/.test(c));
      const ident = line.slice(start, pos);

      if (ident === 'X' || ident === 'C' || ident === 'Z') {
        result.push({ text: ident, token: 'atom' });
        continue;
      }

      if (KEYWORDS.has(ident)) {
        result.push({ text: ident, token: 'keyword' });
        continue;
      }

      if (isHeader) {
        result.push({ text: ident, token: 'variableName' });
        continue;
      }

      result.push({ text: ident, token: 'variableName' });
      continue;
    }

    // Skip punctuation and operators
    pos++;
  }

  return result;
}
