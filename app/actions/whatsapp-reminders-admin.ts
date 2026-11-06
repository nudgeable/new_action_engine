"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentISTDate, istToUTCDateTime } from "@/lib/timezone-utils";
import { getWeekdayIST } from "@/lib/personal-action-generation";
import { RECAP_WEEKDAY, reminderDaysFor } from "@/lib/reminder-days";
import { formatWhatsAppNumber } from "@/lib/whatsapp-contacts";
import { actionReminderTemplateName, weeklyRecapTemplateName } from "@/lib/whatsapp-templates";
import { isWhatsAppSendConfigured } from "@/lib/whatsapp";
import { FIXED_WEEKLY_RECAP_TIME_IST } from "@/lib/action-reminders";
import {
  WHATSAPP_REMINDER_SUBSCRIPTION_COLUMNS,
  isWhatsAppRecapEnabled,
  prepareWhatsAppReminders,
  sendPreparedWhatsAppRecap,
  sendPreparedWhatsAppReminder,
  type WhatsAppReminderSubscription,
} from "@/lib/whatsapp-reminders";

/**
 * Superadmin → Emails & reminders → WhatsApp tab. Mirrors the email reminder
 * queue (app/actions/action-reminders.ts): the upcoming WhatsApp reminders,
 * a manual "send now", and delivery history from the webhook's statuses. The
 * same views cover the Friday recap (kind "recap").
 */

export type WhatsAppMessageKind = "reminder" | "recap";

const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || "admin@actionengine").toLowerCase();
const REMINDER_TIME_IST = "11:30";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function ensureSuperadmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const isSuperadminEmail = user.email?.toLowerCase() === SUPERADMIN_EMAIL;
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "superadmin" && !isSuperadminEmail) throw new Error("Forbidden: superadmin only");
}

async function loadEmails(admin: ReturnType<typeof createAdminClient>, userIds: string[]) {
  const emails = new Map<string, string>();
  const wanted = new Set(userIds);
  for (let page = 1; emails.size < wanted.size; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    for (const user of data.users) if (wanted.has(user.id)) emails.set(user.id, user.email ?? "");
    if (data.users.length < 1000) break;
  }
  return emails;
}

function addDays(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function scheduleLabel(sub: WhatsAppReminderSubscription) {
  if (sub.track === "daily") return "Weekdays at 11:30 AM IST";
  const days = reminderDaysFor(sub).sort((a, b) => a - b).map((day) => WEEKDAYS[day]).join(", ");
  return `${days || "Weekly"} at 11:30 AM IST`;
}

export type UpcomingWhatsAppReminder = {
  subscriptionId: string;
  userId: string;
  email: string;
  fullName: string | null;
  cohortId: string;
  cohortName: string;
  track: "daily" | "weekly";
  scheduleLabel: string;
  /** Next automatic send (11:30 IST), skipping today if today's was already sent. */
  scheduledFor: string | null;
  phone: string | null;
  templateName: string;
  actions: { id: string; title: string }[];
  actionCount: number;
  canSend: boolean;
  blockedReason: string | null;
};

export type WhatsAppReminderOverview = {
  configured: boolean;
  /** Whether the automatic Friday recap is on (it then replaces the Friday reminder). */
  recapEnabled: boolean;
  /** Active plans in a batch, and how many of them have WhatsApp on. */
  activePlans: number;
  whatsappOn: number;
  reminders: UpcomingWhatsAppReminder[];
};

/** Plans with WhatsApp reminders on, ordered by their next automatic send. */
export async function getUpcomingWhatsAppReminders(
  kind: WhatsAppMessageKind = "reminder"
): Promise<{ data: WhatsAppReminderOverview } | { error: string }> {
  try {
    await ensureSuperadmin();
    const admin = createAdminClient();
    const todayIST = getCurrentISTDate();
    const recapEnabled = isWhatsAppRecapEnabled();

    const [{ count: activePlans }, { data: rows, error }, { data: sentToday }] = await Promise.all([
      admin
        .from("personal_action_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true)
        .is("archived_at", null)
        .not("cohort_id", "is", null),
      admin
        .from("personal_action_subscriptions")
        .select(WHATSAPP_REMINDER_SUBSCRIPTION_COLUMNS)
        .eq("is_active", true)
        .eq("whatsapp_reminders_enabled", true)
        .is("archived_at", null)
        .not("cohort_id", "is", null),
      kind === "recap"
        ? admin.from("whatsapp_recap_claims").select("subscription_id").eq("recap_date", todayIST).eq("status", "sent")
        : admin.from("whatsapp_reminder_claims").select("subscription_id").eq("reminder_date", todayIST).eq("status", "sent"),
    ]);
    if (error) return { error: error.message };

    const subs = (rows ?? []) as WhatsAppReminderSubscription[];
    const sentTodayIds = new Set((sentToday ?? []).map((row) => row.subscription_id as string));
    const [prepared, emails] = await Promise.all([
      prepareWhatsAppReminders(admin, subs),
      loadEmails(admin, [...new Set(subs.map((sub) => sub.user_id))]),
    ]);

    const reminders = prepared
      .map((item): UpcomingWhatsAppReminder => {
        // With the recap on, Friday belongs to the recap, not the reminder.
        const days =
          kind === "recap"
            ? [RECAP_WEEKDAY]
            : reminderDaysFor(item.sub).filter((day) => !recapEnabled || day !== RECAP_WEEKDAY);
        let scheduledFor: string | null = null;
        for (let offset = 0; offset <= 7; offset += 1) {
          const date = addDays(todayIST, offset);
          if (!days.includes(getWeekdayIST(date))) continue;
          if (offset === 0 && sentTodayIds.has(item.sub.id)) continue;
          scheduledFor = istToUTCDateTime(date, kind === "recap" ? FIXED_WEEKLY_RECAP_TIME_IST : REMINDER_TIME_IST);
          break;
        }
        return {
          subscriptionId: item.sub.id,
          userId: item.sub.user_id,
          email: emails.get(item.sub.user_id) ?? "",
          fullName: item.fullName,
          cohortId: item.sub.cohort_id,
          cohortName: item.cohortName ?? "Unknown batch",
          track: item.sub.track,
          scheduleLabel: kind === "recap" ? "Fridays at 12:30 PM IST" : scheduleLabel(item.sub),
          scheduledFor,
          phone: item.phone ? formatWhatsAppNumber(item.phone) : null,
          templateName: (kind === "recap" ? weeklyRecapTemplateName : actionReminderTemplateName)(item.actions.length),
          actions: item.actions.map((action) => ({ id: action.id, title: action.title })),
          actionCount: item.actions.length,
          canSend: item.blockedReason === null,
          blockedReason: item.blockedReason,
        };
      })
      .sort(
        (left, right) =>
          (left.scheduledFor ? new Date(left.scheduledFor).getTime() : Infinity) -
            (right.scheduledFor ? new Date(right.scheduledFor).getTime() : Infinity) ||
          (left.fullName ?? left.email).localeCompare(right.fullName ?? right.email)
      );

    return {
      data: {
        configured: isWhatsAppSendConfigured(),
        recapEnabled,
        activePlans: activePlans ?? 0,
        whatsappOn: subs.length,
        reminders,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to load WhatsApp reminders" };
  }
}

export type ManualWhatsAppReminderResult = {
  subscriptionId: string;
  fullName: string | null;
  status: "sent" | "failed" | "skipped";
  templateName?: string;
  error?: string;
};

/**
 * Sends the selected participants' WhatsApp reminder or recap right now. Like
 * the email queue's manual send, it can be repeated and does not use up the
 * automatic send (no claim is taken).
 */
export async function sendWhatsAppRemindersNow(
  subscriptionIds: string[],
  kind: WhatsAppMessageKind = "reminder"
): Promise<{ sent: number; failed: number; skipped: number; data: ManualWhatsAppReminderResult[] } | { error: string }> {
  try {
    await ensureSuperadmin();
    if (!isWhatsAppSendConfigured()) {
      return { error: "WhatsApp sending isn't configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN)." };
    }
    const ids = [...new Set(subscriptionIds)].slice(0, 200);
    if (!ids.length) return { error: "Select at least one participant" };

    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("personal_action_subscriptions")
      .select(WHATSAPP_REMINDER_SUBSCRIPTION_COLUMNS)
      .in("id", ids)
      .eq("is_active", true)
      .is("archived_at", null)
      .not("cohort_id", "is", null);
    if (error) return { error: error.message };

    const prepared = await prepareWhatsAppReminders(admin, (rows ?? []) as WhatsAppReminderSubscription[]);
    const data: ManualWhatsAppReminderResult[] = [];
    for (const item of prepared) {
      if (item.blockedReason) {
        data.push({ subscriptionId: item.sub.id, fullName: item.fullName, status: "skipped", error: item.blockedReason });
        continue;
      }
      const { result, templateName } =
        kind === "recap"
          ? await sendPreparedWhatsAppRecap(item, "weekly_recap_manual")
          : await sendPreparedWhatsAppReminder(item, "action_reminder_manual");
      data.push({
        subscriptionId: item.sub.id,
        fullName: item.fullName,
        status: result.ok ? "sent" : "failed",
        templateName,
        error: result.ok ? undefined : result.error,
      });
    }

    return {
      sent: data.filter((item) => item.status === "sent").length,
      failed: data.filter((item) => item.status === "failed").length,
      skipped: data.filter((item) => item.status === "skipped").length + (ids.length - prepared.length),
      data,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to send WhatsApp reminders" };
  }
}

export type WhatsAppReminderLog = {
  wamid: string;
  fullName: string | null;
  phone: string | null;
  templateName: string | null;
  kind: "automatic" | "manual";
  status: "accepted" | "sent" | "delivered" | "read" | "failed";
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  errorTitle: string | null;
  errorCode: number | null;
};

/** Every WhatsApp reminder sent, newest first, with the webhook's delivery status. */
export async function getWhatsAppReminderLogs(): Promise<{ data: WhatsAppReminderLog[] } | { error: string }> {
  try {
    await ensureSuperadmin();
    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("whatsapp_message_logs")
      .select("wamid, user_id, to_phone, template_name, purpose, status, created_at, delivered_at, read_at, error_title, error_code")
      .in("purpose", ["action_reminder", "action_reminder_manual", "weekly_recap", "weekly_recap_manual"])
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return { error: error.message };

    const userIds = [...new Set((rows ?? []).map((row) => row.user_id as string | null).filter((id): id is string => !!id))];
    const { data: profiles } = userIds.length
      ? await admin.from("profiles").select("id, full_name").in("id", userIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const names = new Map((profiles ?? []).map((profile) => [profile.id as string, profile.full_name as string | null]));

    return {
      data: (rows ?? []).map((row) => ({
        wamid: row.wamid as string,
        fullName: row.user_id ? names.get(row.user_id as string) ?? null : null,
        phone: row.to_phone ? formatWhatsAppNumber(row.to_phone as string) : null,
        templateName: (row.template_name as string | null) ?? null,
        kind: String(row.purpose).endsWith("_manual") ? "manual" : "automatic",
        status: row.status as WhatsAppReminderLog["status"],
        createdAt: row.created_at as string,
        deliveredAt: (row.delivered_at as string | null) ?? null,
        readAt: (row.read_at as string | null) ?? null,
        errorTitle: (row.error_title as string | null) ?? null,
        errorCode: (row.error_code as number | null) ?? null,
      })),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to load WhatsApp history" };
  }
}
