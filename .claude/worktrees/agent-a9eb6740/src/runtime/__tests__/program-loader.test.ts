/**
 * Tests for the program memory loader — Task 7.2.3.
 *
 * Covers:
 *   - intelHex: parse Intel HEX string, verify DataField contains correct values
 *   - rawBinary: load raw binary, verify sequential byte loading
 *   - csv: parse "0x00,0xFF\n0x01,0xAB", verify values at addresses
 *   - logisimV2: parse Logisim v2.0 raw format
 *   - formatDetection: .hex → Intel HEX, .bin → raw binary, .csv → CSV
 *   - bigEndian: load with big-endian option, verify byte order swapped
 */

import { describe, it, expect } from "vitest";
import { DataField } from "../../components/memory/ram.js";
import { loadProgram, detectFormatFromExtension, detectFormatFromContent } from "../program-loader.js";
import { parseIntelHex } from "../hex-parser.js";
import { parseCsv, parseLogisim, parseRawBinary } from "../program-formats.js";

// ---------------------------------------------------------------------------
// Intel HEX test data
// ---------------------------------------------------------------------------

// A minimal Intel HEX file loading two data records plus EOF.
// Record: :LLAAAATT[DD...]CC
// :02000000AABB?? — 2 bytes at 0x0000: 0xAA, 0xBB
// Generated with correct checksums.
function makeIntelHexLine(byteCount: number, address: number, recordType: number, data: number[]): string {
  const bytes: number[] = [byteCount, (address >> 8) & 0xFF, address & 0xFF, recordType, ...data];
  const sum = bytes.reduce((a, b) => a + b, 0) & 0xFF;
  const checksum = (~sum + 1) & 0xFF;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  return `:${hex}${checksum.toString(16).padStart(2, "0").toUpperCase()}`;
}

function makeIntelHex(entries: Array<{ address: number; data: number[] }>): string {
  const lines: string[] = [];
  for (const { address, data } of entries) {
    lines.push(makeIntelHexLine(data.length, address, 0x00, data));
  }
  lines.push(makeIntelHexLine(0, 0, 0x01, [])); // EOF
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests: Intel HEX parser
// ---------------------------------------------------------------------------

describe("parseIntelHex", () => {
  it("parses a simple two-byte record at address 0x0000", () => {
    const hex = makeIntelHex([{ address: 0x0000, data: [0xAA, 0xBB] }]);
    const bytes = parseIntelHex(hex);
    expect(bytes.length).toBe(2);
    expect(bytes[0]).toEqual({ address: 0, value: 0xAA });
    expect(bytes[1]).toEqual({ address: 1, value: 0xBB });
  });

  it("parses records at non-zero addresses", () => {
    const hex = makeIntelHex([{ address: 0x0010, data: [0x11, 0x22, 0x33] }]);
    const bytes = parseIntelHex(hex);
    expect(bytes[0]).toEqual({ address: 0x10, value: 0x11 });
    expect(bytes[1]).toEqual({ address: 0x11, value: 0x22 });
    expect(bytes[2]).toEqual({ address: 0x12, value: 0x33 });
  });

  it("stops parsing at EOF record", () => {
    const hex = makeIntelHex([{ address: 0x0000, data: [0xFF] }]);
    // Append another line after EOF — should be ignored
    const hexWithExtra = hex + "\n" + makeIntelHexLine(1, 0x0001, 0x00, [0x42]);
    const bytes = parseIntelHex(hexWithExtra);
    expect(bytes.length).toBe(1);
    expect(bytes[0].value).toBe(0xFF);
  });

  it("throws on bad checksum", () => {
    // ":01000000AA" — 1 byte at 0x0000, data=0xAA.
    // Correct checksum: sum([01,00,00,00,AA]) = 0xAB, two's complement = 0x55.
    // We use 0x00 instead to trigger a mismatch.
    const line = ":01000000AA00\n:00000001FF";
    expect(() => parseIntelHex(line)).toThrow(/checksum/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadProgram — intelHex
// ---------------------------------------------------------------------------

describe("loadProgram intelHex", () => {
  it("loads Intel HEX into DataField at correct addresses", () => {
    const df = new DataField(256);
    const hex = makeIntelHex([
      { address: 0x00, data: [0xDE, 0xAD] },
      { address: 0x10, data: [0xBE, 0xEF] },
    ]);

    loadProgram(hex, "intelHex", df);

    expect(df.read(0x00)).toBe(0xDE);
    expect(df.read(0x01)).toBe(0xAD);
    expect(df.read(0x10)).toBe(0xBE);
    expect(df.read(0x11)).toBe(0xEF);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseCsv
// ---------------------------------------------------------------------------

describe("parseCsv", () => {
  it("parses hex address and hex value", () => {
    const csv = "0x00,0xFF\n0x01,0xAB";
    const entries = parseCsv(csv);
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({ address: 0x00, value: 0xFF });
    expect(entries[1]).toEqual({ address: 0x01, value: 0xAB });
  });

  it("parses decimal addresses and values", () => {
    const csv = "0,255\n1,171";
    const entries = parseCsv(csv);
    expect(entries[0]).toEqual({ address: 0, value: 255 });
    expect(entries[1]).toEqual({ address: 1, value: 171 });
  });

  it("skips comment lines starting with #", () => {
    const csv = "# comment\n0x00,0x42";
    const entries = parseCsv(csv);
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual({ address: 0, value: 0x42 });
  });

  it("skips empty lines", () => {
    const csv = "\n0x00,0x11\n\n0x01,0x22\n";
    const entries = parseCsv(csv);
    expect(entries.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadProgram — csv
// ---------------------------------------------------------------------------

describe("loadProgram csv", () => {
  it("loads CSV into DataField at correct addresses", () => {
    const df = new DataField(256);
    loadProgram("0x00,0xFF\n0x01,0xAB", "csv", df);
    expect(df.read(0x00)).toBe(0xFF);
    expect(df.read(0x01)).toBe(0xAB);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseRawBinary
// ---------------------------------------------------------------------------

describe("parseRawBinary", () => {
  it("loads sequential bytes at consecutive addresses", () => {
    const buffer = new Uint8Array([0x10, 0x20, 0x30]).buffer;
    const entries = parseRawBinary(buffer, 1, false);
    expect(entries.length).toBe(3);
    expect(entries[0]).toEqual({ address: 0, value: 0x10 });
    expect(entries[1]).toEqual({ address: 1, value: 0x20 });
    expect(entries[2]).toEqual({ address: 2, value: 0x30 });
  });

  it("loads 16-bit words little-endian", () => {
    // Bytes [0x01, 0x02] → little-endian 16-bit = 0x0201
    const buffer = new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer;
    const entries = parseRawBinary(buffer, 2, false);
    expect(entries.length).toBe(2);
    expect(entries[0].value).toBe(0x0201);
    expect(entries[1].value).toBe(0x0403);
  });

  it("loads 16-bit words big-endian", () => {
    // Bytes [0x01, 0x02] → big-endian 16-bit = 0x0102
    const buffer = new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer;
    const entries = parseRawBinary(buffer, 2, true);
    expect(entries[0].value).toBe(0x0102);
    expect(entries[1].value).toBe(0x0304);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadProgram — rawBinary
// ---------------------------------------------------------------------------

describe("loadProgram rawBinary", () => {
  it("loads raw binary bytes into DataField sequentially", () => {
    const df = new DataField(256);
    const buffer = new Uint8Array([0xAA, 0xBB, 0xCC]).buffer;
    loadProgram(buffer, "rawBinary", df);
    expect(df.read(0)).toBe(0xAA);
    expect(df.read(1)).toBe(0xBB);
    expect(df.read(2)).toBe(0xCC);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseLogisim
// ---------------------------------------------------------------------------

describe("parseLogisim", () => {
  it("parses Logisim v2.0 raw format", () => {
    const content = "v2.0 raw\nAA BB CC DD";
    const entries = parseLogisim(content);
    expect(entries.length).toBe(4);
    expect(entries[0]).toEqual({ address: 0, value: 0xAA });
    expect(entries[1]).toEqual({ address: 1, value: 0xBB });
    expect(entries[2]).toEqual({ address: 2, value: 0xCC });
    expect(entries[3]).toEqual({ address: 3, value: 0xDD });
  });

  it("parses Logisim v3.0 raw format", () => {
    const content = "v3.0 raw\n00 01 02";
    const entries = parseLogisim(content);
    expect(entries.length).toBe(3);
    expect(entries[0]).toEqual({ address: 0, value: 0 });
    expect(entries[1]).toEqual({ address: 1, value: 1 });
    expect(entries[2]).toEqual({ address: 2, value: 2 });
  });

  it("supports run-length encoding N*value", () => {
    const content = "v2.0 raw\n3*FF 00";
    const entries = parseLogisim(content);
    expect(entries.length).toBe(4);
    expect(entries[0]).toEqual({ address: 0, value: 0xFF });
    expect(entries[1]).toEqual({ address: 1, value: 0xFF });
    expect(entries[2]).toEqual({ address: 2, value: 0xFF });
    expect(entries[3]).toEqual({ address: 3, value: 0x00 });
  });

  it("handles newline-separated data", () => {
    const content = "v2.0 raw\n10\n20\n30";
    const entries = parseLogisim(content);
    expect(entries.length).toBe(3);
    expect(entries[0].value).toBe(0x10);
    expect(entries[1].value).toBe(0x20);
    expect(entries[2].value).toBe(0x30);
  });

  it("throws on invalid header", () => {
    expect(() => parseLogisim("v1.0 raw\n00")).toThrow(/header/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadProgram — logisimV2
// ---------------------------------------------------------------------------

describe("loadProgram logisimV2", () => {
  it("loads Logisim v2.0 raw format into DataField", () => {
    const df = new DataField(256);
    loadProgram("v2.0 raw\nDE AD BE EF", "logisimV2", df);
    expect(df.read(0)).toBe(0xDE);
    expect(df.read(1)).toBe(0xAD);
    expect(df.read(2)).toBe(0xBE);
    expect(df.read(3)).toBe(0xEF);
  });
});

// ---------------------------------------------------------------------------
// Tests: format detection
// ---------------------------------------------------------------------------

describe("formatDetection", () => {
  it(".hex extension detected as Intel HEX", () => {
    expect(detectFormatFromExtension("program.hex")).toBe("intelHex");
  });

  it(".ihex extension detected as Intel HEX", () => {
    expect(detectFormatFromExtension("program.ihex")).toBe("intelHex");
  });

  it(".bin extension detected as raw binary", () => {
    expect(detectFormatFromExtension("image.bin")).toBe("rawBinary");
  });

  it(".csv extension detected as CSV", () => {
    expect(detectFormatFromExtension("data.csv")).toBe("csv");
  });

  it("content starting with ':' detected as Intel HEX", () => {
    expect(detectFormatFromContent(":020000000000FE")).toBe("intelHex");
  });

  it("content starting with 'v2.0 raw' detected as logisimV2", () => {
    expect(detectFormatFromContent("v2.0 raw\n00 01")).toBe("logisimV2");
  });

  it("content starting with 'v3.0 raw' detected as logisimV3", () => {
    expect(detectFormatFromContent("v3.0 raw\n00 01")).toBe("logisimV3");
  });

  it("falls back to extension when content is ambiguous", () => {
    expect(detectFormatFromContent("some data", "file.csv")).toBe("csv");
    expect(detectFormatFromContent("some data", "file.bin")).toBe("rawBinary");
  });
});

// ---------------------------------------------------------------------------
// Tests: big-endian load
// ---------------------------------------------------------------------------

describe("bigEndian", () => {
  it("loadProgram rawBinary with bigEndian=true swaps byte order for 16-bit words", () => {
    const df = new DataField(256);
    // Bytes [0x01, 0x00] → big-endian 16-bit = 0x0100 (not 0x0001)
    const buffer = new Uint8Array([0x01, 0x00]).buffer;
    loadProgram(buffer, "rawBinary", df, { wordSize: 2, bigEndian: true });
    expect(df.read(0)).toBe(0x0100);
  });

  it("loadProgram rawBinary with bigEndian=false (default) uses little-endian", () => {
    const df = new DataField(256);
    // Bytes [0x01, 0x00] → little-endian 16-bit = 0x0001
    const buffer = new Uint8Array([0x01, 0x00]).buffer;
    loadProgram(buffer, "rawBinary", df, { wordSize: 2, bigEndian: false });
    expect(df.read(0)).toBe(0x0001);
  });
});
