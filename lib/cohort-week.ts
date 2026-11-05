import { createAdminClient } from "@/lib/supabase/admin";
import { istToUTCDateTime, utcToISTDate } from "@/lib/timezone-utils";

type Admin = ReturnType<typeof createAdminClient>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** IST midnight for a YYYY-MM-DD calendar date. */
export function weekAnchorFromIstDate(istDate: string): Date {
  return new Date(istToUTCDateTime(istDate, "00:00"));
}

/**
 * Week origin for an ISO timestamp: IST midnight of the IST calendar day it
 * falls on. Date-only strings (YYYY-MM-DD) are IST calendar dates, not UTC.
 */
export function weekAnchorFromTimestamp(iso: string): Date {
  if (DATE_ONLY.test(iso)) return weekAnchorFromIstDate(iso);
  const istDate = utcToISTDate(iso);
  return istDate ? weekAnchorFromIstDate(istDate) : new Date(iso);
}

/** 1-indexed week number for `date` relative to a week's IST-midnight origin. */
export function weekNumberFor(date: Date, anchor: Date): number {
  const diffDays = Math.floor((date.getTime() - anchor.getTime()) / DAY_MS);
  return Math.max(1, Math.floor(diffDays / WEEK_DAYS) + 1);
}

/** Highest elapsed week number across batch origins (at least 1). */
export function elapsedWeekCount(anchors: Iterable<Date>, now = new Date()): number {
  let maxWeek = 1;
  for (const anchor of anchors) {
    maxWeek = Math.max(maxWeek, weekNumberFor(now, anchor));
  }
  return maxWeek;
}

/**
 * Last week a chart axis should show. Each batch counts up to its current week
 * but stops at its programme length (`cohorts.max_weeks`; null = no limit), so
 * a finished batch stops gaining empty weeks. `dataWeeks` extends the axis so
 * activity after the programme ends stays visible; weeks that haven't started
 * yet are ignored.
 */
export function chartWeekCount(
  anchors: Map<string, Date>,
  maxWeeks: Map<string, number | null>,
  dataWeeks: Iterable<number> = [],
  now = new Date()
): number {
  let lastWeek = 1;
  for (const [cohortId, anchor] of anchors) {
    const elapsed = elapsedWeekCount([anchor], now);
    lastWeek = Math.max(lastWeek, Math.min(elapsed, maxWeeks.get(cohortId) ?? elapsed));
  }
  const elapsedWeeks = elapsedWeekCount(anchors.values(), now);
  for (const week of dataWeeks) {
    if (week <= elapsedWeeks) lastWeek = Math.max(lastWeek, week);
  }
  return lastWeek;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIstDate(istDate: string): { year: number; month: number; day: number } | null {
  const [year, month, day] = istDate.split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

function formatIstDayMonth(istDate: string): string {
  const parsed = parseIstDate(istDate);
  if (!parsed) return istDate;
  return `${parsed.day} ${MONTHS_SHORT[parsed.month - 1]}`;
}

/** Inclusive IST calendar range for a 1-indexed week from the delivery-date origin. */
export function weekRangeIst(weekNumber: number, anchor: Date): { startIst: string; endIst: string } {
  const n = Math.max(1, weekNumber);
  const start = new Date(anchor.getTime() + (n - 1) * WEEK_DAYS * DAY_MS);
  const end = new Date(start.getTime() + (WEEK_DAYS - 1) * DAY_MS);
  return {
    startIst: utcToISTDate(start.toISOString()),
    endIst: utcToISTDate(end.toISOString()),
  };
}

/** Chart DTO fields; null when batches do not share one delivery-date origin. */
export function weekRangeFields(
  weekNumber: number,
  anchor: Date | null
): { weekStartIst: string | null; weekEndIst: string | null } {
  if (!anchor) return { weekStartIst: null, weekEndIst: null };
  const { startIst, endIst } = weekRangeIst(weekNumber, anchor);
  return { weekStartIst: startIst, weekEndIst: endIst };
}

/** Compact chart label, e.g. "24–30 Aug" or "31 Aug – 6 Sep". */
export function formatWeekRangeLabel(startIst: string, endIst: string): string {
  const start = parseIstDate(startIst);
  const end = parseIstDate(endIst);
  if (!start || !end) return `${startIst} – ${endIst}`;
  if (start.month === end.month && start.year === end.year) {
    return `${start.day}–${end.day} ${MONTHS_SHORT[start.month - 1]}`;
  }
  return `${formatIstDayMonth(startIst)} – ${formatIstDayMonth(endIst)}`;
}

/**
 * A single week origin to label chart axes with. Returns the shared IST-midnight
 * anchor when every batch starts on the same delivery day; otherwise null so
 * "All batches" does not show a misleading date range.
 */
export function sharedWeekAnchor(anchors: Iterable<Date>): Date | null {
  let sharedIst: string | null = null;
  let shared: Date | null = null;
  for (const anchor of anchors) {
    const ist = utcToISTDate(anchor.toISOString());
    if (!ist) continue;
    if (sharedIst === null) {
      sharedIst = ist;
      shared = anchor;
    } else if (ist !== sharedIst) {
      return null;
    }
  }
  return shared;
}

/** Programme length per cohort (`cohorts.max_weeks`), for `chartWeekCount`. */
export async function resolveCohortMaxWeeks(
  admin: Admin,
  cohortIds: string[]
): Promise<Map<string, number | null>> {
  if (!cohortIds.length) return new Map();
  const { data } = await admin.from("cohorts").select("id, max_weeks").in("id", cohortIds);
  return new Map(
    ((data ?? []) as { id: string; max_weeks: number | null }[]).map((c) => [c.id, c.max_weeks])
  );
}

/**
 * Per-cohort week origin for admin charts. Prefers the IST date of the first
 * action delivery (`user_actions.scheduled_at`); falls back to the earliest
 * `cohort_dates.event_date`, then `cohorts.created_at`.
 */
export async function resolveCohortWeekAnchors(
  admin: Admin,
  cohortIds: string[]
): Promise<Map<string, Date>> {
  const anchors = new Map<string, Date>();
  if (!cohortIds.length) return anchors;

  const { data: cohortRows } = await admin.from("cohorts").select("id, created_at").in("id", cohortIds);
  for (const c of (cohortRows ?? []) as { id: string; created_at: string }[]) {
    anchors.set(c.id, weekAnchorFromTimestamp(c.created_at));
  }

  const { data: dateRows } = await admin
    .from("cohort_dates")
    .select("cohort_id, event_date")
    .in("cohort_id", cohortIds)
    .order("event_date", { ascending: true });
  const seenDates = new Set<string>();
  for (const d of (dateRows ?? []) as { cohort_id: string; event_date: string }[]) {
    if (seenDates.has(d.cohort_id)) continue;
    seenDates.add(d.cohort_id);
    anchors.set(d.cohort_id, weekAnchorFromIstDate(d.event_date));
  }

  const { data: deliveryRows } = await admin
    .from("user_actions")
    .select("cohort_id, scheduled_at")
    .in("cohort_id", cohortIds)
    .not("scheduled_at", "is", null);
  const firstDelivery = new Map<string, string>();
  for (const row of (deliveryRows ?? []) as { cohort_id: string | null; scheduled_at: string | null }[]) {
    if (!row.cohort_id || !row.scheduled_at) continue;
    const prev = firstDelivery.get(row.cohort_id);
    if (!prev || row.scheduled_at < prev) firstDelivery.set(row.cohort_id, row.scheduled_at);
  }
  for (const [id, iso] of firstDelivery) {
    anchors.set(id, weekAnchorFromTimestamp(iso));
  }

  return anchors;
}
