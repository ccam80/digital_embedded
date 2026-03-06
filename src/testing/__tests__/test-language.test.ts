/**
 * Tests for the Digital test language tokenizer.
 *
 * Tests:
 *   - tokenizeComment:  "# comment" → classified as comment
 *   - tokenizeKeyword:  "loop(3)" → "loop" classified as keyword
 *   - tokenizeHexValue: "0xFF" classified as atom (value)
 *
 * Uses the tokenizeLine() utility exported from test-language.ts,
 * which runs the tokenizer in isolation without requiring CodeMirror's DOM.
 */

import { describe, it, expect } from 'vitest';
import { tokenizeLine } from '../test-language.js';

describe('Digital test language tokenizer', () => {
  // -------------------------------------------------------------------------
  // tokenizeComment
  // -------------------------------------------------------------------------

  it('tokenizeComment — "# comment" → classified as comment', () => {
    const tokens = tokenizeLine('# this is a comment', false);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('comment');
    expect(tokens[0].text).toBe('# this is a comment');
  });

  it('tokenizeComment — inline comment after values → comment token at end', () => {
    const tokens = tokenizeLine('0 1 # inline comment', false);

    const commentToken = tokens.find((t) => t.token === 'comment');
    expect(commentToken).toBeDefined();
    expect(commentToken!.text).toContain('#');
  });

  // -------------------------------------------------------------------------
  // tokenizeKeyword
  // -------------------------------------------------------------------------

  it('tokenizeKeyword — "loop" in "loop(3)" → loop classified as keyword', () => {
    // tokenizeLine processes just the identifier parts; parens are punctuation
    const tokens = tokenizeLine('loop(3)', false);

    const loopToken = tokens.find((t) => t.text === 'loop');
    expect(loopToken).toBeDefined();
    expect(loopToken!.token).toBe('keyword');
  });

  it('tokenizeKeyword — "end" classified as keyword', () => {
    const tokens = tokenizeLine('end loop', false);

    const endToken = tokens.find((t) => t.text === 'end');
    expect(endToken).toBeDefined();
    expect(endToken!.token).toBe('keyword');
  });

  it('tokenizeKeyword — "repeat" classified as keyword', () => {
    const tokens = tokenizeLine('repeat(5)', false);

    const repeatToken = tokens.find((t) => t.text === 'repeat');
    expect(repeatToken).toBeDefined();
    expect(repeatToken!.token).toBe('keyword');
  });

  it('tokenizeKeyword — "bits" classified as keyword', () => {
    const tokens = tokenizeLine('bits(4, x)', false);

    const bitsToken = tokens.find((t) => t.text === 'bits');
    expect(bitsToken).toBeDefined();
    expect(bitsToken!.token).toBe('keyword');
  });

  // -------------------------------------------------------------------------
  // tokenizeHexValue
  // -------------------------------------------------------------------------

  it('tokenizeHexValue — "0xFF" classified as atom (value)', () => {
    const tokens = tokenizeLine('0xFF', false);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('atom');
    expect(tokens[0].text).toBe('0xFF');
  });

  it('tokenizeHexValue — "0x1A3C" classified as atom', () => {
    const tokens = tokenizeLine('0x1A3C', false);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('atom');
    expect(tokens[0].text).toBe('0x1A3C');
  });

  it('tokenizeHexValue — uppercase 0X prefix also classified as atom', () => {
    const tokens = tokenizeLine('0XFF', false);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('atom');
    expect(tokens[0].text).toBe('0XFF');
  });

  // -------------------------------------------------------------------------
  // Value tokens (X, C, Z, decimal numbers)
  // -------------------------------------------------------------------------

  it('valueToken — "X" classified as atom (don\'t care)', () => {
    const tokens = tokenizeLine('X', false);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('atom');
    expect(tokens[0].text).toBe('X');
  });

  it('valueToken — "C" classified as atom (clock)', () => {
    const tokens = tokenizeLine('C', false);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('atom');
    expect(tokens[0].text).toBe('C');
  });

  it('valueToken — "Z" classified as atom (high-Z)', () => {
    const tokens = tokenizeLine('Z', false);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('atom');
    expect(tokens[0].text).toBe('Z');
  });

  it('valueToken — decimal "0" and "1" classified as atom', () => {
    const tokens = tokenizeLine('0 1', false);

    expect(tokens).toHaveLength(2);
    expect(tokens[0].token).toBe('atom');
    expect(tokens[0].text).toBe('0');
    expect(tokens[1].token).toBe('atom');
    expect(tokens[1].text).toBe('1');
  });

  // -------------------------------------------------------------------------
  // Header line: signal names → variableName
  // -------------------------------------------------------------------------

  it('headerLine — signal names on header line → variableName tokens', () => {
    const tokens = tokenizeLine('A B Y', true);

    expect(tokens).toHaveLength(3);
    for (const t of tokens) {
      expect(t.token).toBe('variableName');
    }
    expect(tokens[0].text).toBe('A');
    expect(tokens[1].text).toBe('B');
    expect(tokens[2].text).toBe('Y');
  });

  it('headerLine — multi-char signal names → variableName tokens', () => {
    const tokens = tokenizeLine('CLK DATA_IN OUT_BUS', true);

    expect(tokens).toHaveLength(3);
    expect(tokens[0].token).toBe('variableName');
    expect(tokens[0].text).toBe('CLK');
    expect(tokens[1].token).toBe('variableName');
    expect(tokens[1].text).toBe('DATA_IN');
    expect(tokens[2].token).toBe('variableName');
    expect(tokens[2].text).toBe('OUT_BUS');
  });

  // -------------------------------------------------------------------------
  // Mixed line
  // -------------------------------------------------------------------------

  it('mixedLine — data row with decimal values → all atom tokens', () => {
    const tokens = tokenizeLine('0 1 X 255', false);

    expect(tokens).toHaveLength(4);
    for (const t of tokens) {
      expect(t.token).toBe('atom');
    }
  });
});
