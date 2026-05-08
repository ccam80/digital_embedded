// Unit tests for the parseTestData pure-function string parser.

import { describe, it, expect } from "vitest";
import { parseTestData } from "../testcase.js";

const SIMPLE_TEST_DATA = `A B | Y
0 0   0
0 1   1
1 0   1
1 1   1`;

const COMMENTED_TEST_DATA = `# This is a test for OR gate
# Inputs: A, B  Output: Y
A B | Y
# All-zero case
0 0   0
0 1   1
1 0   1
1 1   1`;

describe("parseTestData", () => {
  describe("headerParsing", () => {
    it("extracts pin names from header line", () => {
      const result = parseTestData(SIMPLE_TEST_DATA);
      expect(result.pinNames).toEqual(["A", "B", "Y"]);
    });

    it("pipe character is ignored in header", () => {
      const data = "A B | Y Z\n0 0   0 1";
      const result = parseTestData(data);
      expect(result.pinNames).toEqual(["A", "B", "Y", "Z"]);
    });

    it("empty string returns empty pinNames and rows", () => {
      const result = parseTestData("");
      expect(result.pinNames).toHaveLength(0);
      expect(result.rows).toHaveLength(0);
    });

    it("only comments returns empty result", () => {
      const result = parseTestData("# comment line\n# another comment");
      expect(result.pinNames).toHaveLength(0);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe("rowParsing", () => {
    it("parses all data rows", () => {
      const result = parseTestData(SIMPLE_TEST_DATA);
      expect(result.rows).toHaveLength(4);
    });

    it("row tokens match whitespace-split values", () => {
      const result = parseTestData(SIMPLE_TEST_DATA);
      expect(result.rows[0].tokens).toEqual(["0", "0", "0"]);
      expect(result.rows[1].tokens).toEqual(["0", "1", "1"]);
      expect(result.rows[2].tokens).toEqual(["1", "0", "1"]);
      expect(result.rows[3].tokens).toEqual(["1", "1", "1"]);
    });

    it("pipe character is stripped from row tokens", () => {
      const data = "A B | Y\n0 1 | 1";
      const result = parseTestData(data);
      expect(result.rows[0].tokens).toEqual(["0", "1", "1"]);
    });

    it("comment lines inside data are filtered out", () => {
      const result = parseTestData(COMMENTED_TEST_DATA);
      // Header + 4 data rows (the comment inside data is filtered)
      expect(result.rows).toHaveLength(4);
    });
  });

  describe("donTCareEntries", () => {
    it("x tokens preserved as 'x' in row", () => {
      const data = "A B | Y\n0 x   1";
      const result = parseTestData(data);
      expect(result.rows[0].tokens[1]).toBe("x");
    });

    it("X (uppercase) tokens preserved", () => {
      const data = "A B | Y\nX 0   0";
      const result = parseTestData(data);
      expect(result.rows[0].tokens[0]).toBe("X");
    });
  });

  describe("multipleOutputs", () => {
    it("parses multiple output columns", () => {
      const data = "A B | S C\n0 0   0 0\n0 1   1 0\n1 0   1 0\n1 1   0 1";
      const result = parseTestData(data);
      expect(result.pinNames).toEqual(["A", "B", "S", "C"]);
      expect(result.rows).toHaveLength(4);
      expect(result.rows[3].tokens).toEqual(["1", "1", "0", "1"]);
    });
  });

  describe("crlfHandling", () => {
    it("handles CRLF line endings", () => {
      const data = "A B | Y\r\n0 0   0\r\n0 1   1";
      const result = parseTestData(data);
      expect(result.rows).toHaveLength(2);
    });
  });
});
