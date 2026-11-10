import { describe, expect, it } from "vitest";
import {
  MAX_ACTION_CATEGORIES,
  matchActionCategory,
  parseActionCategories,
  sanitizeActionCategories,
} from "@/lib/action-categories";

describe("sanitizeActionCategories", () => {
  it("trims and drops blank rows", () => {
    expect(sanitizeActionCategories(["  Feedback ", "", "Coaching"])).toEqual({ categories: ["Feedback", "Coaching"] });
  });

  it("allows an empty list (categories off)", () => {
    expect(sanitizeActionCategories([])).toEqual({ categories: [] });
  });

  it("rejects more than the maximum", () => {
    const tooMany = Array.from({ length: MAX_ACTION_CATEGORIES + 1 }, (_, i) => `C${i}`);
    expect(sanitizeActionCategories(tooMany).error).toMatch(/at most/);
  });

  it("rejects duplicates regardless of case", () => {
    expect(sanitizeActionCategories(["Feedback", "feedback"]).error).toMatch(/different/);
  });

  it("rejects over-long names", () => {
    expect(sanitizeActionCategories(["x".repeat(41)]).error).toMatch(/too long/);
  });
});

describe("parseActionCategories", () => {
  it("ignores non-arrays and junk entries", () => {
    expect(parseActionCategories(null)).toEqual([]);
    expect(parseActionCategories(["A", 3, " ", "a", "B"])).toEqual(["A", "B"]);
  });
});

describe("matchActionCategory", () => {
  it("returns the batch's spelling for a case-insensitive match", () => {
    expect(matchActionCategory(" coaching ", ["Coaching"])).toBe("Coaching");
  });

  it("returns null for anything off the list", () => {
    expect(matchActionCategory("Other", ["Coaching"])).toBeNull();
    expect(matchActionCategory(undefined, ["Coaching"])).toBeNull();
  });
});
