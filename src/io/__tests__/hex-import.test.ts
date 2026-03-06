/**
 * Tests for hex-import — task 4.3.5.
 */

import { describe, it, expect } from "vitest";
import { importHex, parseLogisimHex, parseIntelHex, parseBinaryFile } from "../hex-import";

function encodeText(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("HexImport", () => {
  it("logisimFormat", () => {
    const text = "v2.0 raw\n0 1 2 3 ff";
    const df = parseLogisimHex(text);
    expect(df.getWord(0)).toBe(0n);
    expect(df.getWord(1)).toBe(1n);
    expect(df.getWord(2)).toBe(2n);
    expect(df.getWord(3)).toBe(3n);
    expect(df.getWord(4)).toBe(255n);
  });

  it("logisimRunLength", () => {
    const text = "v2.0 raw\n4*0 ff";
    const df = parseLogisimHex(text);
    expect(df.getWord(0)).toBe(0n);
    expect(df.getWord(1)).toBe(0n);
    expect(df.getWord(2)).toBe(0n);
    expect(df.getWord(3)).toBe(0n);
    expect(df.getWord(4)).toBe(255n);
  });

  it("logisimMultipleLines", () => {
    const text = "v2.0 raw\n0 1\n2 3\nff";
    const df = parseLogisimHex(text);
    expect(df.getWord(0)).toBe(0n);
    expect(df.getWord(4)).toBe(255n);
  });

  it("logisimComment", () => {
    const text = "v2.0 raw\n# this is a comment\n1 2 3";
    const df = parseLogisimHex(text);
    expect(df.getWord(0)).toBe(1n);
    expect(df.getWord(1)).toBe(2n);
    expect(df.getWord(2)).toBe(3n);
  });

  it("logisimInvalidHeaderThrows", () => {
    expect(() => parseLogisimHex("v1.0 raw\n0 1")).toThrow(/invalid/i);
  });

  it("intelHexBasic", () => {
    // A simple Intel HEX record: 4 bytes starting at address 0x0000
    // :04000000 01020304 F5 (checksum)
    // len=04, addr=0000, type=00, data=01 02 03 04, checksum=F5
    // checksum = (256 - (0x04+0x00+0x00+0x00+0x01+0x02+0x03+0x04)) & 0xFF
    //          = (256 - 0x0E) & 0xFF = 0xF2 — let me recalculate
    // sum = 4+0+0+0+1+2+3+4 = 14 = 0x0E; checksum = (0x100 - 0x0E) & 0xFF = 0xF2
    // 04 bytes, addr 0x0000, type 0x00, data = 01 02 03 04
    // sum = 04+00+00+00+01+02+03+04 = 0x0E, checksum byte = 0x100-0x0E = 0xF2
    const record = ":0400000001020304F2\n:00000001FF";
    const df = parseIntelHex(record, 8, false);
    expect(df.getWord(0)).toBe(1n);
    expect(df.getWord(1)).toBe(2n);
    expect(df.getWord(2)).toBe(3n);
    expect(df.getWord(3)).toBe(4n);
  });

  it("intelHexExtendedAddress", () => {
    // Extended linear address record type 04 shifts address left by 16 bits.
    // :020000040001F9  sets upper 16 bits to 0x0001, so segment = 0x00010000
    // sum = 02+00+00+04+00+01 = 0x07; checksum = 0x100-0x07 = 0xF9
    // Then a data record at local addr 0x0000:
    // :01000000AASS  — 1 byte = 0xAA at byte addr 0x00010000
    // sum = 01+00+00+00+AA = 0xAB; checksum = 0x100-0xAB = 0x55
    const records = [
      ":020000040001F9",
      ":01000000AA55",
      ":00000001FF",
    ].join("\n");
    const df = parseIntelHex(records, 8, false);
    // Byte address 0x00010000 = word address 0x00010000 (dataBits=8)
    expect(df.getWord(0x00010000)).toBe(0xAAn);
  });

  it("intelHexChecksumError", () => {
    // Corrupt the checksum byte
    const record = ":0400000001020304FF\n:00000001FF";
    expect(() => parseIntelHex(record, 8, false)).toThrow(/checksum/i);
  });

  it("binaryFile8bit", () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const df = parseBinaryFile(data, 8, false);
    expect(df.getWord(0)).toBe(1n);
    expect(df.getWord(1)).toBe(2n);
    expect(df.getWord(2)).toBe(3n);
    expect(df.getWord(3)).toBe(4n);
  });

  it("binaryFile16bitLE", () => {
    // Little-endian: byte 0 is LSB, byte 1 is MSB
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const df = parseBinaryFile(data, 16, false);
    expect(df.getWord(0)).toBe(0x0201n);
    expect(df.getWord(1)).toBe(0x0403n);
  });

  it("binaryFile16bitBE", () => {
    // Big-endian: byte 0 is MSB, byte 1 is LSB
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const df = parseBinaryFile(data, 16, true);
    expect(df.getWord(0)).toBe(0x0102n);
    expect(df.getWord(1)).toBe(0x0304n);
  });

  it("autoDetectsLogisimFormat", () => {
    const data = encodeText("v2.0 raw\n1 2 3");
    const df = importHex(data, 8, false);
    expect(df.getWord(0)).toBe(1n);
    expect(df.getWord(1)).toBe(2n);
    expect(df.getWord(2)).toBe(3n);
  });

  it("autoDetectsIntelHexFormat", () => {
    const record = ":0400000001020304F2\n:00000001FF";
    const data = encodeText(record);
    const df = importHex(data, 8, false);
    expect(df.getWord(0)).toBe(1n);
    expect(df.getWord(1)).toBe(2n);
    expect(df.getWord(2)).toBe(3n);
    expect(df.getWord(3)).toBe(4n);
  });

  it("autoDetectsBinaryFile", () => {
    // Not a text format — raw bytes
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const df = importHex(data, 8, false);
    expect(df.getWord(0)).toBe(0xDEn);
    expect(df.getWord(1)).toBe(0xADn);
    expect(df.getWord(2)).toBe(0xBEn);
    expect(df.getWord(3)).toBe(0xEFn);
  });

  it("autoDetectsFormat", () => {
    // Logisim
    const logisimData = encodeText("v2.0 raw\nff 00");
    const df1 = importHex(logisimData, 8, false);
    expect(df1.getWord(0)).toBe(0xFFn);
    expect(df1.getWord(1)).toBe(0n);

    // Intel HEX
    const intelData = encodeText(":0400000001020304F2\n:00000001FF");
    const df2 = importHex(intelData, 8, false);
    expect(df2.getWord(0)).toBe(1n);

    // Binary (non-text bytes)
    const binData = new Uint8Array([0x01, 0x02]);
    const df3 = importHex(binData, 8, false);
    expect(df3.getWord(0)).toBe(1n);
  });
});
