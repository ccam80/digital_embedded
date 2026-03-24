import { describe, it, expect } from "vitest";
import { parseModelCard, parseModelFile } from "../model-parser.js";
import type { ParsedModel, ParseError } from "../model-parser.js";

describe("ModelParser", () => {
  it("parses_simple_diode_model", () => {
    const text = ".MODEL D1N4148 D (IS=2.52e-9 N=1.752 RS=0.568)";
    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    const model = result as ParsedModel;
    expect(model.name).toBe("D1N4148");
    expect(model.deviceType).toBe("D");
    expect(model.params["IS"]).toBeCloseTo(2.52e-9, 20);
    expect(model.params["N"]).toBeCloseTo(1.752, 10);
    expect(model.params["RS"]).toBeCloseTo(0.568, 10);
  });

  it("parses_bjt_model", () => {
    const text = ".MODEL 2N2222 NPN (IS=14.34E-15 BF=255.9 NF=1.005 VAF=74.03 IKF=0.2847)";
    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    const model = result as ParsedModel;
    expect(model.name).toBe("2N2222");
    expect(model.deviceType).toBe("NPN");
    expect(model.params["IS"]).toBeCloseTo(14.34e-15, 25);
    expect(model.params["BF"]).toBeCloseTo(255.9, 5);
    expect(model.params["NF"]).toBeCloseTo(1.005, 5);
    expect(model.params["VAF"]).toBeCloseTo(74.03, 5);
    expect(model.params["IKF"]).toBeCloseTo(0.2847, 5);
  });

  it("handles_multiline_continuation", () => {
    const text = [
      ".MODEL 2N2222 NPN (",
      "+ IS=14.34E-15",
      "+ BF=255.9",
      "+ NF=1.005",
      ")",
    ].join("\n");

    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    const model = result as ParsedModel;
    expect(model.name).toBe("2N2222");
    expect(model.deviceType).toBe("NPN");
    expect(model.params["IS"]).toBeCloseTo(14.34e-15, 25);
    expect(model.params["BF"]).toBeCloseTo(255.9, 5);
    expect(model.params["NF"]).toBeCloseTo(1.005, 5);
  });

  it("handles_spice_suffixes", () => {
    const text = ".MODEL TestMod NMOS (R=4.7K C=100P L=10M)";
    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    const model = result as ParsedModel;
    expect(model.params["R"]).toBeCloseTo(4700, 5);
    expect(model.params["C"]).toBeCloseTo(100e-12, 25);
    expect(model.params["L"]).toBeCloseTo(10e-3, 10);
  });

  it("ignores_comments", () => {
    const text = [
      "* This is a full-line comment",
      ".MODEL MyDiode D (IS=1e-14",
      "; inline comment here",
      "+ N=1.0)",
    ].join("\n");

    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    const model = result as ParsedModel;
    expect(model.name).toBe("MyDiode");
    expect(model.deviceType).toBe("D");
    expect(model.params["IS"]).toBeCloseTo(1e-14, 25);
    expect(model.params["N"]).toBeCloseTo(1.0, 10);
  });

  it("returns_error_for_invalid_syntax", () => {
    const text = ".MODEL";
    const result = parseModelCard(text);

    expect("message" in result).toBe(true);
    const err = result as ParseError;
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.line).toBe(1);
  });

  it("multiple_models_in_file", () => {
    const text = [
      ".MODEL D1N4148 D (IS=2.52e-9 N=1.752)",
      ".MODEL 2N2222 NPN (IS=14.34E-15 BF=255.9)",
      ".MODEL IRF510 NMOS (VTO=3.3 KP=0.5)",
    ].join("\n");

    const { models, errors } = parseModelFile(text);

    expect(errors).toHaveLength(0);
    expect(models).toHaveLength(3);
    expect(models[0].name).toBe("D1N4148");
    expect(models[1].name).toBe("2N2222");
    expect(models[2].name).toBe("IRF510");
  });

  it("level_extracted", () => {
    const text = ".MODEL M1 NMOS (LEVEL=2 VTO=0.7)";
    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    const model = result as ParsedModel;
    expect(model.level).toBe(2);
    expect(model.params["VTO"]).toBeCloseTo(0.7, 10);
  });

  it("level_defaults_to_1_when_omitted", () => {
    const text = ".MODEL M1 NMOS (VTO=0.7 KP=120e-6)";
    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    const model = result as ParsedModel;
    expect(model.level).toBe(1);
  });

  it("parses_pmos_and_jfet_types", () => {
    const pmos = parseModelCard(".MODEL MP1 PMOS (VTO=-0.7)") as ParsedModel;
    expect(pmos.deviceType).toBe("PMOS");

    const njfet = parseModelCard(".MODEL J1 NJFET (VTO=-2)") as ParsedModel;
    expect(njfet.deviceType).toBe("NJFET");

    const pjfet = parseModelCard(".MODEL J2 PJFET (VTO=2)") as ParsedModel;
    expect(pjfet.deviceType).toBe("PJFET");

    const pnp = parseModelCard(".MODEL Q1 PNP (BF=80)") as ParsedModel;
    expect(pnp.deviceType).toBe("PNP");
  });

  it("handles_meg_suffix", () => {
    const text = ".MODEL Test NMOS (RG=1.5MEG)";
    const result = parseModelCard(text) as ParsedModel;
    expect(result.params["RG"]).toBeCloseTo(1.5e6, 5);
  });

  it("file_parser_handles_continuation_and_comments", () => {
    const text = [
      "* SPICE model file",
      ".MODEL D1 D (",
      "+ IS=1e-14",
      "+ N=1.0",
      ")",
      "* another model",
      ".MODEL Q1 NPN (BF=100 IS=1e-16)",
    ].join("\n");

    const { models, errors } = parseModelFile(text);

    expect(errors).toHaveLength(0);
    expect(models).toHaveLength(2);
    expect(models[0].name).toBe("D1");
    expect(models[0].params["IS"]).toBeCloseTo(1e-14, 25);
    expect(models[1].name).toBe("Q1");
    expect(models[1].params["BF"]).toBeCloseTo(100, 5);
  });

  it("file_parser_collects_errors_for_invalid_models", () => {
    const text = [
      ".MODEL D1 D (IS=1e-14)",
      ".MODEL",
      ".MODEL Q1 NPN (BF=100)",
    ].join("\n");

    const { models, errors } = parseModelFile(text);

    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
