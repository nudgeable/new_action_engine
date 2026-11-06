/**
 * Which weekdays a plan's action reminder goes out on (0 = Sunday). Shared by
 * the email (lib/action-reminders.ts) and WhatsApp (lib/whatsapp-reminders.ts)
 * reminders so both channels fire on exactly the same days. Dependency-free
 * so it can be unit tested.
 */

/** Daily-track plans are delivered and reminded Monday–Friday (= DAILY_DELIVERY_DAYS in lib/personal-action-generation.ts). */
const DAILY_REMINDER_DAYS = [1, 2, 3, 4, 5];

export function reminderDaysFor(sub: {
  track: "daily" | "weekly";
  days_of_week: number[] | null;
  day_of_week: number | null;
}): number[] {
  if (sub.track === "daily") return [...DAILY_REMINDER_DAYS];
  return sub.days_of_week ?? (sub.day_of_week != null ? [sub.day_of_week] : []);
}

/** YYYY-MM-DD shifted by `days` (calendar arithmetic, timezone-free). */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Friday recap day. */
export const RECAP_WEEKDAY = 5;

/**
 * The Friday a WhatsApp recap run on `todayIST` belongs to, or null. Friday is
 * the normal run; Saturday is the catch-up for a Friday that failed or didn't
 * run, and claims against the same Friday so nobody gets two.
 */
export function whatsappRecapDate(todayIST: string): string | null {
  const weekday = weekdayOf(todayIST);
  if (weekday === RECAP_WEEKDAY) return todayIST;
  if (weekday === RECAP_WEEKDAY + 1) return shiftDate(todayIST, -1);
  return null;
}

/**
 * The reminder occurrence (IST date) that should go out on `todayIST`, or null.
 *
 * This is the most recent reminder day on or before today, so a day the cron
 * didn't run (e.g. it was disabled) is caught up on the next run instead of
 * being skipped until the following week. Returns null once that occurrence
 * was already sent, or when it predates the subscription (`startDate`).
 */
export function dueReminderDate(
  sub: {
    track: "daily" | "weekly";
    days_of_week: number[] | null;
    day_of_week: number | null;
    last_reminder_sent_date: string | null;
  },
  todayIST: string,
  startDate?: string | null
): string | null {
  const days = reminderDaysFor(sub);
  for (let offset = 0; offset < 7; offset += 1) {
    const date = shiftDate(todayIST, -offset);
    if (!days.includes(weekdayOf(date))) continue;
    if (sub.last_reminder_sent_date && sub.last_reminder_sent_date >= date) return null;
    if (startDate && date < startDate) return null;
    return date;
  }
  return null;
}
