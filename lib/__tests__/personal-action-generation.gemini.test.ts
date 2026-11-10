import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises generateDraftActions' concurrency cap and rate-limit retry
 * end-to-end, with the actual Gemini SDK client mocked out (no network
 * calls, no API key required).
 */

const generateContent = vi.fn();

vi.mock("@/lib/gemini", () => ({
  isGeminiConfigured: () => true,
  getGeminiClient: () => ({ models: { generateContent } }),
  GEMINI_MODEL: "gemini-2.5-flash-test",
}));

function rateLimitError(message = "429 Too Many Requests") {
  return Object.assign(new Error(message), { name: "ApiError", status: 429 });
}

function draftResponse(count: number) {
  return {
    text: JSON.stringify({
      actions: Array.from({ length: count }, (_, i) => ({
        title: `Title ${i}`,
        how: `How ${i}`,
        why: `Why ${i}`,
        timeEstimate: "5 mins",
      })),
    }),
  };
}

describe("generateDraftActions: Gemini concurrency + rate limiting", () => {
  beforeEach(() => {
    vi.resetModules();
    generateContent.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caps concurrent Gemini calls at GEMINI_MAX_CONCURRENCY", async () => {
    vi.stubEnv("GEMINI_MAX_CONCURRENCY", "2");
    const { generateDraftActions } = await import("@/lib/personal-action-generation");

    let concurrent = 0;
    let peak = 0;
    generateContent.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return draftResponse(1);
    });

    const calls = Array.from({ length: 5 }, () =>
      generateDraftActions({
        trainingContent: "",
        userNotes: "",
        businessContext: "",
        focusThemes: [],
        count: 1,
      })
    );
    const results = await Promise.all(calls);

    expect(results.every((r) => !r.error && r.drafts?.length === 1)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(generateContent).toHaveBeenCalledTimes(5);
  });

  it("transparently retries a 429 and still returns drafts", async () => {
    vi.stubEnv("GEMINI_MAX_RETRIES", "3");
    vi.stubEnv("GEMINI_RETRY_BASE_MS", "1");
    const { generateDraftActions } = await import("@/lib/personal-action-generation");

    let attempts = 0;
    generateContent.mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) throw rateLimitError();
      return draftResponse(2);
    });

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 2,
    });

    expect(result.error).toBeUndefined();
    expect(result.drafts).toHaveLength(2);
    expect(attempts).toBe(3);
  });

  it("surfaces a clear error once retries are exhausted on a persistent 429", async () => {
    vi.stubEnv("GEMINI_MAX_RETRIES", "1");
    vi.stubEnv("GEMINI_RETRY_BASE_MS", "1");
    const { generateDraftActions } = await import("@/lib/personal-action-generation");

    generateContent.mockImplementation(async () => {
      throw rateLimitError();
    });

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 2,
    });

    expect(result.drafts).toBeUndefined();
    expect(result.error).toMatch(/rate-limited/i);
    expect(generateContent).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("does not retry a non-rate-limit failure", async () => {
    const { generateDraftActions } = await import("@/lib/personal-action-generation");

    generateContent.mockImplementation(async () => {
      throw new Error("Invalid API key");
    });

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 2,
    });

    expect(result.error).toBe("Invalid API key");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("getPinnedFirstActionTitle", () => {
  it("returns the Surge opener with the company name substituted in, case-insensitively", async () => {
    const { getPinnedFirstActionTitle } = await import("@/lib/personal-action-generation");
    expect(getPinnedFirstActionTitle("Surge")).toBe(
      "Conduct a Teach-Back meeting with my team about the learning from this Surge Module."
    );
    expect(getPinnedFirstActionTitle("SURGE")).toBe(
      "Conduct a Teach-Back meeting with my team about the learning from this SURGE Module."
    );
  });

  it("returns null for companies without a pinned opener", async () => {
    const { getPinnedFirstActionTitle } = await import("@/lib/personal-action-generation");
    expect(getPinnedFirstActionTitle("Acme Inc")).toBeNull();
    expect(getPinnedFirstActionTitle(null)).toBeNull();
    expect(getPinnedFirstActionTitle(undefined)).toBeNull();
    expect(getPinnedFirstActionTitle("")).toBeNull();
  });
});

describe("generateDraftActions: pinned first action", () => {
  beforeEach(() => {
    vi.resetModules();
    generateContent.mockReset();
  });

  it("forces the exact pinned title onto draft index 0 even if the model paraphrases it", async () => {
    const { generateDraftActions, getPinnedFirstActionTitle } = await import("@/lib/personal-action-generation");
    const pinned = getPinnedFirstActionTitle("Surge")!;

    generateContent.mockResolvedValue({
      text: JSON.stringify({
        actions: [
          { title: "Run a team debrief on the module", how: "How 0", why: "Why 0", timeEstimate: "10 mins" },
          { title: "Title 1", how: "How 1", why: "Why 1", timeEstimate: "5 mins" },
        ],
      }),
    });

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 2,
      pinnedFirstAction: pinned,
    });

    expect(result.error).toBeUndefined();
    // The pinned action takes slot 0 of the requested count — it is not
    // appended on top, so the participant's chosen plan size is unaffected.
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts?.[0]?.title).toBe(pinned);
    expect(result.drafts?.[1]?.title).toBe("Title 1");

    const promptText = generateContent.mock.calls[0][0].contents as string;
    expect(promptText).toContain(pinned);
    expect(promptText).toContain("REQUIRED FIRST ACTION");
    expect(promptText).toContain("Generate the remaining 1 action(s) normally");
  });

  it("caps the batch at `count` even if the model returns count+1 (misreading the pinned action as an addition)", async () => {
    const { generateDraftActions, getPinnedFirstActionTitle } = await import("@/lib/personal-action-generation");
    const pinned = getPinnedFirstActionTitle("Surge")!;

    // Reproduces the reported bug: user planned for 12, model returned 13
    // (treating the pinned title as extra rather than one of the 12).
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        actions: Array.from({ length: 13 }, (_, i) => ({
          title: `Title ${i}`,
          how: `How ${i}`,
          why: `Why ${i}`,
          timeEstimate: "5 mins",
        })),
      }),
    });

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 12,
      pinnedFirstAction: pinned,
    });

    expect(result.drafts).toHaveLength(12);
    expect(result.drafts?.[0]?.title).toBe(pinned);
  });

  it("leaves titles untouched when no pinned first action is given", async () => {
    const { generateDraftActions } = await import("@/lib/personal-action-generation");

    generateContent.mockResolvedValue(draftResponse(1));

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 1,
    });

    expect(result.drafts?.[0]?.title).toBe("Title 0");
  });
});

describe("generateDraftActions: batch action categories", () => {
  beforeEach(() => {
    vi.resetModules();
    generateContent.mockReset();
  });

  it("asks the model to pick a category per action and keeps the batch's spelling", async () => {
    const { generateDraftActions, draftsToActionRows } = await import("@/lib/personal-action-generation");
    const categories = ["Giving feedback", "Coaching", "Delegation"];

    generateContent.mockResolvedValue({
      text: JSON.stringify({
        actions: [
          { title: "T0", how: "H0", why: "W0", timeEstimate: "5 mins", category: "giving feedback" },
          { title: "T1", how: "H1", why: "W1", timeEstimate: "5 mins", category: "Giving feedback" },
          { title: "T2", how: "H2", why: "W2", timeEstimate: "5 mins", category: "Delegation." },
        ],
      }),
    });

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 3,
      categories,
    });

    // Uneven split is fine; near-miss spellings snap to the batch's own.
    expect(result.drafts?.map((draft) => draft.category)).toEqual(["Giving feedback", "Giving feedback", "Delegation"]);
    expect(generateContent).toHaveBeenCalledTimes(1);

    const request = generateContent.mock.calls[0][0];
    expect(request.contents).toContain("ACTION_CATEGORIES");
    expect(request.contents).toContain("- Delegation");
    const itemSchema = request.config.responseSchema.properties.actions.items;
    expect(itemSchema.properties.category.enum).toEqual(categories);
    expect(itemSchema.required).toContain("category");

    const rows = draftsToActionRows(result.drafts!, "company", "user", "cohort");
    expect(rows.map((row) => row.category)).toEqual(["Giving feedback", "Giving feedback", "Delegation"]);
  });

  it("asks Gemini again to classify any action left without a category", async () => {
    const { generateDraftActions } = await import("@/lib/personal-action-generation");
    const categories = ["Giving feedback", "Coaching", "Delegation"];

    generateContent
      .mockResolvedValueOnce({
        text: JSON.stringify({
          actions: [
            { title: "T0", how: "H0", why: "W0", timeEstimate: "5 mins", category: "Coaching" },
            { title: "T1", how: "H1", why: "W1", timeEstimate: "5 mins" },
            { title: "T2", how: "H2", why: "W2", timeEstimate: "5 mins", category: "Something else" },
          ],
        }),
      })
      .mockResolvedValueOnce({ text: JSON.stringify({ categories: ["Delegation", "Giving feedback"] }) });

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 3,
      categories,
    });

    expect(result.drafts?.map((draft) => draft.category)).toEqual(["Coaching", "Delegation", "Giving feedback"]);
    expect(generateContent).toHaveBeenCalledTimes(2);
    const followUp = generateContent.mock.calls[1][0];
    expect(followUp.contents).toContain("What: T1");
    expect(followUp.contents).toContain("What: T2");
    expect(followUp.contents).not.toContain("What: T0");
    expect(followUp.config.responseSchema.properties.categories.items.enum).toEqual(categories);
  });

  it("still tags every action when the follow-up call fails", async () => {
    const { generateDraftActions } = await import("@/lib/personal-action-generation");
    const categories = ["Giving feedback", "Delegation"];

    generateContent
      .mockResolvedValueOnce({
        text: JSON.stringify({
          actions: [
            { title: "Hand one task to a teammate", how: "Pick a task worth delegation", why: "Frees your time", timeEstimate: "5 mins" },
            { title: "T1", how: "H1", why: "W1", timeEstimate: "5 mins" },
          ],
        }),
      })
      .mockRejectedValueOnce(new Error("network down"));

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 2,
      categories,
    });

    expect(result.error).toBeUndefined();
    // Word overlap ("delegation") wins; no overlap falls back to the first category.
    expect(result.drafts?.map((draft) => draft.category)).toEqual(["Delegation", "Giving feedback"]);
  });

  it("leaves the schema and prompt category-free when the batch has none", async () => {
    const { generateDraftActions } = await import("@/lib/personal-action-generation");
    generateContent.mockResolvedValue(draftResponse(1));

    const result = await generateDraftActions({
      trainingContent: "",
      userNotes: "",
      businessContext: "",
      focusThemes: [],
      count: 1,
    });

    expect(result.drafts?.[0]?.category).toBeNull();
    const request = generateContent.mock.calls[0][0];
    expect(request.contents).not.toContain("ACTION_CATEGORIES");
    expect(request.config.responseSchema.properties.actions.items.properties.category).toBeUndefined();
  });
});
