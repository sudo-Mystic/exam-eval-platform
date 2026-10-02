import { describe, it, expect } from "vitest";
import {
  parseJson,
  validateExtraction,
  validateScheme,
  validateBaseline,
} from "../worker/handlers";

describe("parseJson", () => {
  it("parses plain JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips markdown fences", () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("throws on invalid JSON", () => {
    expect(() => parseJson("not json")).toThrow();
  });
});

describe("validateExtraction", () => {
  const good = {
    questions: [
      {
        qNo: "1",
        text: "Define photosynthesis.",
        maxMarks: 5,
        qType: "descriptive",
        sortOrder: 0,
      },
      {
        qNo: "2a",
        subPart: "a",
        text: "Solve x^2 = 4.",
        maxMarks: null,
        qType: "numerical",
        topic: "quadratic equations",
        sortOrder: 1,
        flags: ["low-confidence-read"],
      },
    ],
  };

  it("accepts a valid extraction, null marks allowed", () => {
    const out = validateExtraction(good);
    expect(out).toHaveLength(2);
    expect(out[0].qNo).toBe("1");
    expect(out[1].maxMarks).toBeNull();
    expect(out[1].flags).toEqual(["low-confidence-read"]);
  });

  it("rejects duplicate qNo", () => {
    expect(() =>
      validateExtraction({
        questions: [
          { qNo: "1", text: "a", maxMarks: 1, qType: "descriptive", sortOrder: 0 },
          { qNo: "1", text: "b", maxMarks: 1, qType: "descriptive", sortOrder: 1 },
        ],
      })
    ).toThrow(/duplicate/i);
  });

  it("rejects unknown qType", () => {
    expect(() =>
      validateExtraction({
        questions: [{ qNo: "1", text: "a", maxMarks: 1, qType: "essay", sortOrder: 0 }],
      })
    ).toThrow(/qtype/i);
  });

  it("rejects missing text", () => {
    expect(() =>
      validateExtraction({
        questions: [{ qNo: "1", maxMarks: 1, qType: "descriptive", sortOrder: 0 }],
      })
    ).toThrow(/text/);
  });

  it("rejects negative marks", () => {
    expect(() =>
      validateExtraction({
        questions: [{ qNo: "1", text: "a", maxMarks: -2, qType: "descriptive", sortOrder: 0 }],
      })
    ).toThrow(/maxmarks/i);
  });

  it("rejects non-array questions", () => {
    expect(() => validateExtraction({})).toThrow();
    expect(() => validateExtraction(null)).toThrow();
  });
});

describe("validateScheme", () => {
  const known = new Set(["1", "2"]);

  it("accepts valid criteria", () => {
    const out = validateScheme(
      {
        criteria: [
          { qNo: "1", label: "Correct formula", maxMarks: 2, descriptors: "Full for correct formula." },
        ],
      },
      known
    );
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Correct formula");
  });

  it("keeps orphan criteria for faculty mapping instead of dropping", () => {
    const out = validateScheme(
      {
        criteria: [
          { qNo: "9", label: "Stray", maxMarks: 1, descriptors: "x" },
        ],
      },
      known
    );
    expect(out).toHaveLength(1);
    expect(out[0].qNo).toBe("9");
  });

  it("rejects missing label", () => {
    expect(() =>
      validateScheme({ criteria: [{ qNo: "1", maxMarks: 1, descriptors: "x" }] }, known)
    ).toThrow(/label/);
  });

  it("rejects non-positive marks", () => {
    expect(() =>
      validateScheme(
        { criteria: [{ qNo: "1", label: "x", maxMarks: 0, descriptors: "x" }] },
        known
      )
    ).toThrow(/maxmarks/i);
  });
});

describe("validateBaseline", () => {
  const good = {
    solutionText: "Photosynthesis converts light to chemical energy.",
    alternatives: ["Light-dependent reactions produce ATP."],
    criterionNotes: [{ label: "Key points", note: "Award for mentioning chlorophyll." }],
  };

  it("accepts a valid baseline", () => {
    const out = validateBaseline(good);
    expect(out.solutionText).toContain("Photosynthesis");
    expect(out.alternatives).toHaveLength(1);
  });

  it("trims and caps alternatives at 5", () => {
    const out = validateBaseline({
      ...good,
      alternatives: [" a ", "", "b", "c", "d", "e", "f", "g"],
    });
    expect(out.alternatives).toHaveLength(5);
    expect(out.alternatives[0]).toBe("a");
  });

  it("rejects missing solutionText", () => {
    expect(() => validateBaseline({ alternatives: [], criterionNotes: [] })).toThrow(
      /solutiontext/i
    );
  });

  it("rejects malformed criterionNotes", () => {
    expect(() =>
      validateBaseline({ ...good, criterionNotes: [{ label: "x" }] })
    ).toThrow(/criterionnotes/i);
  });
});
