/**
 * Tokenizer tests — task 4.3.1.
 */

import { describe, it, expect } from "vitest";
import { Tokenizer, TokenType } from "../tokenizer";

function tokens(src: string): Array<{ type: TokenType; value: string }> {
  const t = new Tokenizer(src);
  const result: Array<{ type: TokenType; value: string }> = [];
  while (true) {
    const tok = t.next();
    result.push({ type: tok.type, value: tok.value });
    if (tok.type === TokenType.EOF) break;
  }
  return result;
}

function types(src: string): TokenType[] {
  return tokens(src).map(t => t.type);
}

describe("Tokenizer", () => {
  it("empty source produces EOF", () => {
    const t = new Tokenizer("");
    expect(t.next().type).toBe(TokenType.EOF);
  });

  it("single number", () => {
    const t = new Tokenizer("42");
    const tok = t.next();
    expect(tok.type).toBe(TokenType.NUMBER);
    expect(tok.value).toBe("42");
  });

  it("hex number", () => {
    const t = new Tokenizer("0xFF");
    const tok = t.next();
    expect(tok.type).toBe(TokenType.NUMBER);
    expect(tok.value).toBe("0xFF");
  });

  it("float number", () => {
    const t = new Tokenizer("3.14");
    const tok = t.next();
    expect(tok.type).toBe(TokenType.DOUBLE);
    expect(tok.value).toBe("3.14");
  });

  it("string literal", () => {
    const t = new Tokenizer('"hello"');
    const tok = t.next();
    expect(tok.type).toBe(TokenType.STRING);
    expect(tok.value).toBe("hello");
  });

  it("string escape sequences", () => {
    const t = new Tokenizer('"a\\nb"');
    const tok = t.next();
    expect(tok.type).toBe(TokenType.STRING);
    expect(tok.value).toBe("a\nb");
  });

  it("identifiers", () => {
    const t = new Tokenizer("foo bar baz");
    expect(t.next().type).toBe(TokenType.IDENT);
    expect(t.next().type).toBe(TokenType.IDENT);
    expect(t.next().type).toBe(TokenType.IDENT);
    expect(t.next().type).toBe(TokenType.EOF);
  });

  it("keywords", () => {
    expect(types("if")[0]).toBe(TokenType.IF);
    expect(types("else")[0]).toBe(TokenType.ELSE);
    expect(types("for")[0]).toBe(TokenType.FOR);
    expect(types("while")[0]).toBe(TokenType.WHILE);
    expect(types("func")[0]).toBe(TokenType.FUNC);
    expect(types("repeat")[0]).toBe(TokenType.REPEAT);
    expect(types("until")[0]).toBe(TokenType.UNTIL);
    expect(types("return")[0]).toBe(TokenType.RETURN);
    expect(types("export")[0]).toBe(TokenType.EXPORT);
    expect(types("true")[0]).toBe(TokenType.TRUE);
    expect(types("false")[0]).toBe(TokenType.FALSE);
  });

  it("operators", () => {
    const toks = types("+ - * / % & | ^ ~ = != < <= > >= << >>>");
    expect(toks[0]).toBe(TokenType.ADD);
    expect(toks[1]).toBe(TokenType.SUB);
    expect(toks[2]).toBe(TokenType.MUL);
    expect(toks[3]).toBe(TokenType.DIV);
    expect(toks[4]).toBe(TokenType.MOD);
    expect(toks[5]).toBe(TokenType.AND);
    expect(toks[6]).toBe(TokenType.OR);
    expect(toks[7]).toBe(TokenType.XOR);
    expect(toks[8]).toBe(TokenType.NOT);
    expect(toks[9]).toBe(TokenType.EQUAL);
    expect(toks[10]).toBe(TokenType.NOTEQUAL);
    expect(toks[11]).toBe(TokenType.LESS);
    expect(toks[12]).toBe(TokenType.LESSEQUAL);
    expect(toks[13]).toBe(TokenType.GREATER);
    expect(toks[14]).toBe(TokenType.GREATEREQUAL);
    expect(toks[15]).toBe(TokenType.SHIFTLEFT);
    expect(toks[16]).toBe(TokenType.SHIFTRIGHT);
  });

  it("delimiters", () => {
    const toks = types("( ) { } [ ] . : ; ,");
    expect(toks[0]).toBe(TokenType.OPEN);
    expect(toks[1]).toBe(TokenType.CLOSE);
    expect(toks[2]).toBe(TokenType.OPENBRACE);
    expect(toks[3]).toBe(TokenType.CLOSEDBRACE);
    expect(toks[4]).toBe(TokenType.OPENSQUARE);
    expect(toks[5]).toBe(TokenType.CLOSEDSQUARE);
    expect(toks[6]).toBe(TokenType.DOT);
    expect(toks[7]).toBe(TokenType.COLON);
    expect(toks[8]).toBe(TokenType.SEMICOLON);
    expect(toks[9]).toBe(TokenType.COMMA);
  });

  it("line comment skipped", () => {
    const t = new Tokenizer("a // this is a comment\nb");
    expect(t.next().type).toBe(TokenType.IDENT);
    expect(t.next().type).toBe(TokenType.IDENT);
    expect(t.next().type).toBe(TokenType.EOF);
  });

  it("line tracking", () => {
    const t = new Tokenizer("a\nb");
    const a = t.next();
    expect(a.line).toBe(1);
    const b = t.next();
    expect(b.line).toBe(2);
  });

  it("peek does not consume", () => {
    const t = new Tokenizer("42");
    const p1 = t.peek();
    const p2 = t.peek();
    const n = t.next();
    expect(p1.type).toBe(TokenType.NUMBER);
    expect(p2.type).toBe(TokenType.NUMBER);
    expect(n.type).toBe(TokenType.NUMBER);
    expect(t.next().type).toBe(TokenType.EOF);
  });

  it("expect succeeds on matching type", () => {
    const t = new Tokenizer("42");
    const tok = t.expect(TokenType.NUMBER);
    expect(tok.value).toBe("42");
  });

  it("expect throws on wrong type", () => {
    const t = new Tokenizer("42");
    expect(() => t.expect(TokenType.IDENT)).toThrow();
  });

  it("escaped identifier with single quotes", () => {
    const t = new Tokenizer("'a b'");
    const tok = t.next();
    expect(tok.type).toBe(TokenType.IDENT);
    expect(tok.value).toBe("a b");
  });

  it("readText reads up to code block start", () => {
    const t = new Tokenizer("Hello <? world");
    const text = t.readText();
    expect(text).toBe("Hello ");
    const next = t.next();
    expect(next.value).toBe("world");
  });

  it("codeend token from ?>", () => {
    const t = new Tokenizer("?>");
    const tok = t.next();
    expect(tok.type).toBe(TokenType.CODEEND);
  });

  it("codeend token from ?}", () => {
    const t = new Tokenizer("?}");
    const tok = t.next();
    expect(tok.type).toBe(TokenType.CODEEND);
  });

  it("declaration token sequence", () => {
    const toks = types("x := 5");
    expect(toks[0]).toBe(TokenType.IDENT);
    expect(toks[1]).toBe(TokenType.COLON);
    expect(toks[2]).toBe(TokenType.EQUAL);
    expect(toks[3]).toBe(TokenType.NUMBER);
  });

  it("unterminated string throws", () => {
    const t = new Tokenizer('"unterminated');
    expect(() => t.next()).toThrow();
  });
});
