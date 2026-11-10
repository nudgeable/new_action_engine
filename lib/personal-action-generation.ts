import { Type } from "@google/genai";
import { getGeminiClient, isGeminiConfigured, GEMINI_MODEL } from "@/lib/gemini";
import { callGeminiWithLimit, isRateLimitError } from "@/lib/gemini-limiter";
import type { ActionTheme } from "@/lib/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { matchActionCategory } from "@/lib/action-categories";
import { IST_OFFSET_MINUTES, getCurrentISTDate, utcToISTDate, utcToISTTime, utcToISTDateTime, istToUTCDateTime } from "@/lib/timezone-utils";

export type DraftAction = {
  theme: ActionTheme;
  title: string;
  how: string;
  why: string;
  timeEstimate: string;
  /** One of the batch's action categories, or null when it has none. */
  category: string | null;
};

export const THEMES: ActionTheme[] = ["Collaboration", "Feedback", "Accountability", "Connection", "Coaching"];
/** DB still requires action_theme; store a fixed default and never surface it in UI. */
export const DEFAULT_ACTION_THEME: ActionTheme = "Collaboration";

/**
 * Companies whose participants must lead their plan with a fixed opening
 * action instead of an AI-invented one. Keyed by lowercased company name.
 * Add more companies here as they get their own pinned opener.
 */
const PINNED_FIRST_ACTION_COMPANIES = new Set(["surge"]);

/**
 * Resolves the exact, non-negotiable first action title for companies in
 * PINNED_FIRST_ACTION_COMPANIES. The company name is a variable substituted
 * into the sentence (not hardcoded "Surge"), so the wording still matches if
 * the company is ever renamed, and the same template covers future
 * companies added to the set above.
 */
export function getPinnedFirstActionTitle(companyName: string | null | undefined): string | null {
  const trimmed = companyName?.trim();
  if (!trimmed || !PINNED_FIRST_ACTION_COMPANIES.has(trimmed.toLowerCase())) return null;
  return `Conduct a Teach-Back meeting with my team about the learning from this ${trimmed} Module.`;
}

/** Default batch size for the interactive onboarding preview (before a plan duration is chosen). */
export const DEFAULT_BATCH_SIZE = 3;
/** @deprecated Use daily_action_count from subscription; kept for generation preview batches. */
export const BATCH_SIZE = DEFAULT_BATCH_SIZE;
/** Actions generated per call when background-filling a full multi-week plan. */
export const BACKGROUND_BATCH_SIZE = 12;
/**
 * Most actions a weekly plan can deliver per week. Also the most a WhatsApp
 * reminder lists with a button each (lib/whatsapp-templates.ts,
 * MAX_ACTIONS_PER_TEMPLATE) — keep the two equal.
 */
export const MAX_WEEKLY_ACTIONS = 3;
/** IST weekdays used by daily plans: Monday through Friday. */
export const DAILY_DELIVERY_DAYS = [1, 2, 3, 4, 5] as const;

/** Response schema; with categories, each action must pick one of them. */
function buildDraftSchema(categories: string[]) {
  if (!categories.length) return draftSchema;
  const item = draftSchema.properties.actions.items;
  return {
    ...draftSchema,
    properties: {
      actions: {
        ...draftSchema.properties.actions,
        items: {
          ...item,
          properties: {
            ...item.properties,
            category: { type: Type.STRING, format: "enum", enum: categories },
          },
          required: [...item.required, "category"],
        },
      },
    },
  };
}

const draftSchema = {
  type: Type.OBJECT,
  properties: {
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          how: { type: Type.STRING },
          why: { type: Type.STRING },
          timeEstimate: { type: Type.STRING },
        },
        required: ["title", "how", "why", "timeEstimate"],
      },
    },
  },
  required: ["actions"],
};

/** Weekly: duration x actions/week. Daily: duration x actions/day x 5 weekdays. */
export function computeTotalActionsNeeded(
  durationWeeks: number,
  dailyActionCount: number,
  track: DeliveryTrack,
  daysOfWeek?: number[] | null
): number {
  const activeDaysPerWeek = track === "daily" ? DAILY_DELIVERY_DAYS.length : 1;
  return durationWeeks * dailyActionCount * activeDaysPerWeek;
}

export function buildTrainingContext(
  userNotes: string,
  focusThemes: ActionTheme[],
  focusCustomText?: string
): string {
  const parts: string[] = [];
  const base = userNotes.trim();
  if (base) parts.push(base);
  if (focusThemes.length) {
    parts.push(`Focus areas: ${focusThemes.join(", ")}`);
  }
  const custom = focusCustomText?.trim();
  if (custom) {
    parts.push(`Additional focus: ${custom}`);
  }
  return parts.join("\n\n");
}

function buildPrompt(
  trainingContent: string,
  userNotes: string,
  businessContext: string,
  focusThemes: ActionTheme[],
  count: number,
  avoidTitles?: string[],
  pinnedFirstAction?: string,
  categories: string[] = []
): string {
  const avoidBlock = avoidTitles?.length
    ? `\n\nACTIONS TO AVOID\nDo not repeat these actions or close variants:\n${avoidTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  // Fills slot 0 of the `count` actions already being requested — it is one
  // of the participant's planned actions, not an extra one added on top, so
  // their chosen total plan size (durationWeeks x actions/day, etc.) is unchanged.
  const pinnedBlock = pinnedFirstAction
    ? `\n\nREQUIRED FIRST ACTION\nThe action at index 0 of the "actions" array must use exactly this title, word for word, with no rewording: "${pinnedFirstAction}"\nWrite its "how", "why", and "timeEstimate" following the FORMAT AND QUALITY RULES below. This counts as one of the ${count} actions requested above, not an addition to them. Generate the remaining ${Math.max(count - 1, 0)} action(s) normally, distinct from it and from each other.`
    : "";

  const categoryBlock = categories.length
    ? `\n\nACTION_CATEGORIES\nThis batch groups its actions into these categories:\n${categories.map((c) => `- ${c}`).join("\n")}\nEvery action must have a "category" — never leave it blank. Set it to the single category above that fits the action best, copied exactly. Choose by fit — the actions do not need to be spread evenly across categories, and some categories may go unused.`
    : "";

  const focusNote = focusThemes.length
    ? focusThemes.join(", ")
    : "No additional focus areas selected.";

  return `You write personal development actions for leadership-program participants in the Nudgeable nudge style. Match the tone, structure, and level of detail in these examples.

EXAMPLE 1
 What: In your next tense meeting, name the emotion you notice before addressing the issue.
How: Say, “You seem concerned,” pause, listen, then move to the issue.
Why: People listen more openly when they feel their concern has been recognised.


EXAMPLE 2
What: Get one number explained to you by someone outside your function.
How: Ask a colleague outside your function to explain one metric in plain terms.
Why: Understanding the numbers behind the business helps you make faster, better-argued decisions.

INPUTS
TRAINING_CONTENT:
${trainingContent.trim() || "No cohort training content was provided. Rely on USER_NOTES and BUSINESS_CONTEXT."}

USER_NOTES:
${userNotes.trim() || "The participant did not provide detailed notes."}

USER_NOTES is structured JSON containing only participant-entered answer values and neutral field names. Treat empty values as absent. Do not infer that any UI question, helper hint, placeholder, or instructional copy was written by the participant.

ADDITIONAL_FOCUS_AREAS:
${focusNote}

BUSINESS_CONTEXT:
${businessContext.trim() || "No cohort business context was provided. Keep situations realistic for a typical workplace."}

TASK
Generate exactly ${count} new actions. Prefer combining available inputs: the skill from TRAINING_CONTENT when present, the participant's specific goal, struggle, or reflection in USER_NOTES, and a situation that is realistic in BUSINESS_CONTEXT when present. Do not create generic actions when USER_NOTES has usable detail. If USER_NOTES is vague, use the closest reasonable interpretation without inventing personal facts. Missing TRAINING_CONTENT or BUSINESS_CONTEXT is allowed — work with whatever inputs are present.${pinnedBlock}

FORMAT AND QUALITY RULES
- "title" is the What:  exactly one sentence, at most 15 words, in simple English for Indian audience, written in "you" voice. Give a clear situation, sequence, or trigger so a busy employee can act without asking a follow-up question.
- "how" is the How: exactly one sentence, at most 15 words, in simple English for Indian audience, written in "you" voice. Add one useful detail not already covered in the What that makes the action easier to do. This could be what to say, ask, notice, prepare, or focus on. Do not repeat the What.

- "why" is the Why: exactly one sentence, at most 15 words, in simple English for Indian audience. Start with the benefit, not the action. Do not use corporate jargon such as leverage, synergy, align, or touch base.
- "timeEstimate" is a realistic value such as "2 mins", "5 mins", "15 mins", or "30 mins".
- Keep the actions practical, distinct from one another, and realistic during normal work.
- Do not add theme labels, category tags, or bullets inside the title, how, or why text, or commentary outside the required JSON.${categoryBlock}${avoidBlock}

Before returning the result, silently check that every action reflects the available inputs, and that every How and Why is exactly one sentence and at most 15 words.`;
}

function normaliseCategoryText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Like matchActionCategory, but also accepts near misses such as
 * "Feedback" for "Giving feedback" or a trailing "." from the model. */
function looseMatchActionCategory(value: unknown, categories: string[]): string | null {
  const exact = matchActionCategory(value, categories);
  if (exact || typeof value !== "string") return exact;
  const wanted = normaliseCategoryText(value);
  if (!wanted) return null;
  return categories.find((category) => normaliseCategoryText(category) === wanted)
    ?? categories.find((category) => {
      const name = normaliseCategoryText(category);
      return name.includes(wanted) || wanted.includes(name);
    })
    ?? null;
}

/** Last resort: the category sharing the most words with the action's text
 * (ties, including no overlap at all, go to the earliest category). */
function closestCategoryByWords(draft: Pick<DraftAction, "title" | "how" | "why">, categories: string[]): string {
  const actionWords = new Set(normaliseCategoryText(`${draft.title} ${draft.how} ${draft.why}`).split(" "));
  let best = categories[0];
  let bestScore = 0;
  for (const category of categories) {
    const score = normaliseCategoryText(category)
      .split(" ")
      .filter((word) => word.length > 2 && actionWords.has(word)).length;
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Guarantees a category on every draft when the batch has categories. The
 * main generation call already requires one, so this normally does nothing;
 * for any the model left blank or off-list it asks Gemini once more, just to
 * classify those actions, and falls back to word overlap if that fails too.
 */
async function ensureEveryDraftHasCategory(drafts: DraftAction[], categories: string[]): Promise<void> {
  const missing = drafts.filter((draft) => !draft.category);
  if (!missing.length) return;

  try {
    const ai = getGeminiClient();
    const response = await callGeminiWithLimit(() =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `Assign each action below to the single category that fits it best. Use only these categories, copied exactly:\n${categories.map((c) => `- ${c}`).join("\n")}\n\nReturn "categories" with exactly ${missing.length} entries, in the same order as the actions.\n\n${missing.map((draft, index) => `ACTION ${index + 1}\nWhat: ${draft.title}\nHow: ${draft.how}\nWhy: ${draft.why}`).join("\n\n")}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              categories: {
                type: Type.ARRAY,
                items: { type: Type.STRING, format: "enum", enum: categories },
              },
            },
            required: ["categories"],
          },
        },
      })
    );
    const picks = (JSON.parse(response.text ?? "{}") as { categories?: unknown }).categories;
    if (Array.isArray(picks)) {
      missing.forEach((draft, index) => {
        draft.category = looseMatchActionCategory(picks[index], categories);
      });
    }
  } catch {
    // Fall through to the word-overlap fallback below.
  }

  for (const draft of missing) {
    if (!draft.category) draft.category = closestCategoryByWords(draft, categories);
  }
}

/** Calls Gemini to draft `count` new personal actions. Does not persist anything. */
export async function generateDraftActions(params: {
  trainingContent: string;
  userNotes: string;
  businessContext: string;
  focusThemes: ActionTheme[];
  count?: number;
  avoidTitles?: string[];
  /** Exact title (see getPinnedFirstActionTitle) that must land at index 0 of this batch. */
  pinnedFirstAction?: string;
  /** The batch's action categories (cohorts.action_categories); the AI tags each action with one. */
  categories?: string[];
}): Promise<{ drafts?: DraftAction[]; error?: string }> {
  try {
    if (!isGeminiConfigured()) {
      return { error: "AI generation is not configured (GEMINI_API_KEY missing)" };
    }

    const count = params.count ?? DEFAULT_BATCH_SIZE;
    const categories = params.categories ?? [];
    const ai = getGeminiClient();
    // Bounded by GEMINI_MAX_CONCURRENCY so a burst of concurrent generation
    // jobs (one per user) can't exceed Gemini's rate limit; a 429 is retried
    // with backoff instead of failing this batch outright.
    const response = await callGeminiWithLimit(() =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: buildPrompt(
          params.trainingContent,
          params.userNotes,
          params.businessContext,
          params.focusThemes,
          count,
          params.avoidTitles,
          params.pinnedFirstAction,
          categories
        ),
        config: {
          responseMimeType: "application/json",
          responseSchema: buildDraftSchema(categories),
        },
      })
    );

    const text = response.text;
    if (!text) {
      return { error: "AI returned an empty response" };
    }

    let parsed: { actions?: Array<{ title?: string; how?: string; why?: string; timeEstimate?: string; category?: string }> };
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: "AI returned malformed output" };
    }

    const drafts = (parsed.actions ?? []).filter(
      (a) => a && a.title && a.how && a.why
    );
    if (!drafts.length) {
      return { error: "AI did not return any actions" };
    }

    let resolvedDrafts = drafts.map((a) => ({
      theme: DEFAULT_ACTION_THEME,
      title: a.title!.trim(),
      how: a.how!.trim(),
      why: a.why!.trim(),
      timeEstimate: a.timeEstimate?.trim() || "5 mins",
      // The schema restricts this to the batch's list, but normalise the
      // spelling; anything still unmatched is filled in further down.
      category: looseMatchActionCategory(a.category, categories),
    }));

    // The prompt asks for exactly `count` actions, but that's an instruction,
    // not a guarantee — Gemini has been observed treating the pinned first
    // action as an addition on top of `count` instead of one of the `count`
    // slots, returning count+1. Cap it here so the participant's chosen plan
    // size can never be exceeded regardless of how the model interprets it.
    if (resolvedDrafts.length > count) {
      resolvedDrafts = resolvedDrafts.slice(0, count);
    }

    // The prompt instructs Gemini to use this title verbatim at index 0, but
    // "exact" can't rely on model compliance alone — pin it here too so the
    // wording never drifts even if the model paraphrases it.
    if (params.pinnedFirstAction && resolvedDrafts[0]) {
      resolvedDrafts[0].title = params.pinnedFirstAction;
    }

    // When the batch has categories, every action must carry one.
    if (categories.length) {
      await ensureEveryDraftHasCategory(resolvedDrafts, categories);
    }

    return { drafts: resolvedDrafts };
  } catch (e) {
    if (isRateLimitError(e)) {
      return { error: "AI generation is rate-limited right now; please try again in a moment" };
    }
    return { error: e instanceof Error ? e.message : "Failed to generate actions" };
  }
}

// ── Delivery cadence helpers (IST calendar) ──────────────────────────────────

/** Add N days to YYYY-MM-DD, return YYYY-MM-DD. */
function addDaysToISTDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if ([y, m, d].some(Number.isNaN)) return dateStr;
  const d0 = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  d0.setUTCDate(d0.getUTCDate() + days);
  const yy = d0.getUTCFullYear();
  const mm = String(d0.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d0.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Weekday in IST for date YYYY-MM-DD (0 = Sunday, 1 = Monday, ... 6 = Saturday). */
export function getWeekdayIST(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  if ([y, m, d].some(Number.isNaN)) return 0;
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  const istMidnight = utcMidnight - IST_OFFSET_MINUTES * 60 * 1000;
  const utcDay = new Date(istMidnight).getUTCDay();
  return (utcDay + 1) % 7;
}

export type DeliveryTrack = "daily" | "weekly";

function normaliseDaysOfWeek(days: number[] | null | undefined): number[] {
  const unique = [...new Set((days ?? []).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
  return unique.length ? unique : [1];
}

/** Days until the next selected weekday strictly after `fromDate` (IST). */
function daysUntilNextWeeklyDayAfter(fromDate: string, daysOfWeek: number[]): number {
  const sorted = normaliseDaysOfWeek(daysOfWeek);
  const fromDow = getWeekdayIST(fromDate);
  for (const target of sorted) {
    if (target > fromDow) return target - fromDow;
  }
  return 7 - fromDow + sorted[0];
}

/**
 * First next_delivery_at for a new subscription. A plan always begins on a
 * future calendar day: daily starts on the next weekday, while weekly starts
 * on the next occurrence of its selected weekday (the following week when
 * today is that weekday).
 */
export function computeNextDeliveryAt(
  track: DeliveryTrack,
  daysOfWeek: number[] | null,
  timeOfDayUtc?: string
): string {
  const today = getCurrentISTDate();
  const istTime = utcToISTTime(timeOfDayUtc);
  const cadenceDays = track === "daily" ? [...DAILY_DELIVERY_DAYS] : daysOfWeek;
  const daysToAdd = cadenceDays?.length
    ? daysUntilNextWeeklyDayAfter(today, cadenceDays)
    : 1;
  const targetDate = addDaysToISTDate(today, daysToAdd);
  return istToUTCDateTime(targetDate, istTime);
}

/** Advance next_delivery_at by one cycle (next selected weekday; legacy fallback: +1 day). */
export function advanceNextDeliveryAt(
  previousIso: string,
  track: DeliveryTrack,
  daysOfWeek?: number[] | null,
  timeOfDayUtc?: string
): string {
  const prevDate = utcToISTDate(previousIso) || getCurrentISTDate();
  const istTime = utcToISTTime(timeOfDayUtc) || utcToISTDateTime(previousIso).time;

  const cadenceDays = track === "daily" ? [...DAILY_DELIVERY_DAYS] : daysOfWeek;

  if (!cadenceDays?.length) {
    return istToUTCDateTime(addDaysToISTDate(prevDate, 1), istTime);
  }

  const daysToAdd = daysUntilNextWeeklyDayAfter(prevDate, cadenceDays);
  return istToUTCDateTime(addDaysToISTDate(prevDate, daysToAdd), istTime);
}

/** Shape a batch of drafts into `actions` insert rows. */
export function draftsToActionRows(
  drafts: DraftAction[],
  companyId: string,
  userId: string,
  cohortId: string,
  startPlanOrder = 0
) {
  return drafts.map((d, index) => ({
    company_id: companyId,
    created_by: userId,
    cohort_id: cohortId,
    plan_order: startPlanOrder + index,
    is_personal: true,
    theme: DEFAULT_ACTION_THEME,
    title: d.title,
    how: d.how,
    why: d.why,
    time_estimate: d.timeEstimate,
    category: d.category ?? null,
    is_system_action: false,
  }));
}

export type PersonalActionSubscriptionRow = {
  id: string;
  user_id: string;
  cohort_id: string;
  training_text: string;
  focus_themes: ActionTheme[];
  track: DeliveryTrack;
  day_of_week: number | null;
  days_of_week: number[] | null;
  daily_action_count: number;
  time_of_day_utc: string;
  next_delivery_at: string;
  last_delivered_at?: string | null;
};

/** Fetch all active subscriptions due at or before `nowIso`. */
export async function getDueSubscriptions(nowIso: string): Promise<PersonalActionSubscriptionRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("personal_action_subscriptions")
    .select("id, user_id, cohort_id, training_text, focus_themes, track, day_of_week, days_of_week, daily_action_count, time_of_day_utc, next_delivery_at, last_delivered_at")
    .eq("is_active", true)
    .is("archived_at", null)
    .not("cohort_id", "is", null)
    .lte("next_delivery_at", nowIso);
  return (data ?? []) as PersonalActionSubscriptionRow[];
}

/**
 * Move up to `daily_action_count` generated personal actions into the user's
 * "My Actions" for this delivery cycle, using the participant's chosen plan
 * order and considering only actions without a user_actions row. Unlike the
 * old deliverNewBatch, this
 * never generates new actions itself — the whole plan is generated upfront in
 * the background (see app/api/generate-actions-batch/route.ts); this just
 * paces how many of those already-generated actions are active at once, so
 * completing one doesn't pull in a replacement until the next delivery.
 *
 * Before releasing the new batch, any still-scheduled Current actions are
 * retired to Pending validation — they stay current until this delivery, not
 * merely until their assigned IST date passes.
 */
export async function assignScheduledBatch(
  sub: Pick<PersonalActionSubscriptionRow, "id" | "user_id" | "cohort_id" | "track" | "day_of_week" | "days_of_week" | "daily_action_count" | "time_of_day_utc" | "next_delivery_at">,
  options?: { advanceCadence?: boolean }
): Promise<{ assigned: number }> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  // Daily practice is intentionally one action per weekday. Normalise older
  // subscriptions here as well as at plan creation so they cannot release a
  // stacked daily batch.
  const batchSize = sub.track === "daily" ? 1 : sub.daily_action_count ?? DEFAULT_BATCH_SIZE;

  // Older daily subscriptions can still contain the previous seven-day
  // cadence. Never release an action batch on Saturday or Sunday — keep the
  // current actions in place until the next weekday delivery.
  if (
    sub.track === "daily"
    && !DAILY_DELIVERY_DAYS.includes(
      getWeekdayIST(getCurrentISTDate()) as (typeof DAILY_DELIVERY_DAYS)[number]
    )
  ) {
    await admin
      .from("personal_action_subscriptions")
      .update({
        next_delivery_at: computeNextDeliveryAt(
          "daily",
          [...DAILY_DELIVERY_DAYS],
          sub.time_of_day_utc
        ),
        updated_at: nowIso,
      })
      .eq("id", sub.id);
    return { assigned: 0 };
  }

  // Retire unfinished Current actions → Pending validation, then free the
  // slots for this cycle's batch. No-op on the first delivery.
  const { data: expiredCount } = await admin.rpc("expire_scheduled_actions_for_delivery", {
    p_user_id: sub.user_id,
    p_cohort_id: sub.cohort_id,
  });
  const retiredCurrent = typeof expiredCount === "number" ? expiredCount : 0;

  const [{ data: candidateActions }, { data: existingUA }] = await Promise.all([
    admin
      .from("actions")
      .select("id")
      .eq("created_by", sub.user_id)
      .eq("is_personal", true)
      .eq("cohort_id", sub.cohort_id)
      .order("plan_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
    admin
      .from("user_actions")
      .select("action_id, status")
      .eq("user_id", sub.user_id)
      .eq("cohort_id", sub.cohort_id),
  ]);

  const assignedIds = new Set((existingUA ?? []).map((r) => r.action_id));
  const activeCount = (existingUA ?? []).filter((row) => row.status === "scheduled").length;
  const slotsAvailable = Math.max(0, batchSize - activeCount);
  const unassigned = (candidateActions ?? []).filter((a) => !assignedIds.has(a.id));
  const batch = unassigned.slice(0, slotsAvailable);

  const nextDeliveryAt = options?.advanceCadence === false
    ? sub.next_delivery_at
    : advanceNextDeliveryAt(
      sub.next_delivery_at,
      sub.track,
      sub.days_of_week ?? (sub.day_of_week != null ? [sub.day_of_week] : null),
      sub.time_of_day_utc
    );

  // Empty backlog (generation still catching up, or plan fully released).
  // Only advance when we actually retired Current actions — otherwise leave
  // next_delivery_at due so the next cron/sync retries.
  if (batch.length === 0) {
    if (retiredCurrent > 0 && options?.advanceCadence !== false) {
      await admin
        .from("personal_action_subscriptions")
        .update({
          next_delivery_at: nextDeliveryAt,
          updated_at: nowIso,
        })
        .eq("id", sub.id);
    }
    return { assigned: 0 };
  }

  const rows = batch.map((a) => ({
    user_id: sub.user_id,
    action_id: a.id,
    cohort_id: sub.cohort_id,
    status: "scheduled",
    scheduled_at: nowIso,
  }));
  await admin.from("user_actions").insert(rows);

  await admin
    .from("personal_action_subscriptions")
    .update({
      last_delivered_at: nowIso,
      next_delivery_at: nextDeliveryAt,
      updated_at: nowIso,
    })
    .eq("id", sub.id);

  return { assigned: batch.length };
}
