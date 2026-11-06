/**
 * WhatsApp action reminders — Phase 4 of docs/WHATSAPP_REMINDERS_PLAN.md.
 *
 * Runs from the same daily cron as the reminder email
 * (app/api/cron/email-scheduler/route.ts) and mirrors it exactly:
 *   - same plans: active, unarchived, linked to a batch;
 *   - same days: reminderDaysFor() (weekdays on daily, chosen day on weekly);
 *   - same actions: the plan's current ("scheduled") actions for that batch,
 *     via buildReminderActionContext().
 * On top of that a plan only gets WhatsApp when the participant ticked it
 * (whatsapp_reminders_enabled), has a number, and hasn't replied STOP.
 *
 * Idempotent per plan per IST day through claim_whatsapp_reminder
 * (supabase/migrations/084_whatsapp_reminder_claims.sql), independent of the
 * email claim, so one channel failing never blocks or repeats the other.
 *
 * prepareWhatsAppReminders / sendPreparedWhatsAppReminder are shared with the
 * superadmin WhatsApp tab (app/actions/whatsapp-reminders-admin.ts), so a
 * manual send is exactly what the cron would send.
 *
 * The Friday recap (sendWhatsAppWeeklyRecap) goes to the same people with the
 * same current actions, and on Fridays it replaces the reminder, so nobody
 * gets the same list twice. Both changes are off until
 * WHATSAPP_WEEKLY_RECAP_ENABLED is "true", which keeps the normal Friday
 * reminder running until Meta has approved the plan_recap_N templates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentISTDate, istToUTCDateTime } from "@/lib/timezone-utils";
import { getWeekdayIST } from "@/lib/personal-action-generation";
import { RECAP_WEEKDAY, reminderDaysFor, whatsappRecapDate } from "@/lib/reminder-days";
import {
  buildReminderActionContext,
  subscriptionKey,
  type ReminderAction,
  type ReminderSubscription,
} from "@/lib/action-reminders";
import { buildActionReminder, buildWeeklyRecap } from "@/lib/whatsapp-templates";
import { isWhatsAppSendConfigured, sendWhatsAppTemplate, type WhatsAppSendResult } from "@/lib/whatsapp";

type AdminClient = ReturnType<typeof createAdminClient>;

export function isWhatsAppRecapEnabled(): boolean {
  return process.env.WHATSAPP_WEEKLY_RECAP_ENABLED === "true";
}

export type WhatsAppReminderSubscription = ReminderSubscription & { whatsapp_reminders_enabled: boolean };

export const WHATSAPP_REMINDER_SUBSCRIPTION_COLUMNS =
  "id, user_id, cohort_id, track, day_of_week, days_of_week, email_reminders_enabled, last_reminder_sent_date, whatsapp_reminders_enabled";

export type PreparedWhatsAppReminder = {
  sub: WhatsAppReminderSubscription;
  fullName: string | null;
  phone: string | null;
  optedOut: boolean;
  cohortName: string | null;
  companyName: string | null;
  actions: ReminderAction[];
  /** Why this plan can't be sent right now, or null when it can. */
  blockedReason: string | null;
};

/** Matches the email's fixed reminder time; only used for the shared context lookup. */
const REMINDER_TIME_IST = "11:30";

/**
 * Resolves everything needed to send each plan's WhatsApp reminder — number,
 * opt-out, current actions — and why it can't be sent.
 */
export async function prepareWhatsAppReminders(
  admin: AdminClient,
  subs: WhatsAppReminderSubscription[]
): Promise<PreparedWhatsAppReminder[]> {
  if (!subs.length) return [];
  const userIds = [...new Set(subs.map((sub) => sub.user_id))];
  const [{ data: contacts, error: contactError }, { data: profiles, error: profileError }, context] = await Promise.all([
    admin.from("whatsapp_contacts").select("user_id, phone, opted_out_at").in("user_id", userIds),
    admin.from("profiles").select("id, full_name").in("id", userIds),
    buildReminderActionContext(
      admin,
      subs.map((sub) => ({ sub, scheduledFor: istToUTCDateTime(getCurrentISTDate(), REMINDER_TIME_IST) }))
    ),
  ]);
  if (contactError || profileError) {
    throw new Error(`load contacts/profiles: ${contactError?.message ?? profileError?.message}`);
  }
  const contactByUser = new Map((contacts ?? []).map((c) => [c.user_id as string, c]));
  const profileByUser = new Map((profiles ?? []).map((p) => [p.id as string, p]));
  const { actionIdsBySubscription, actionMap, cohortNameMap, companyByCohortId } = context;

  return subs.map((sub) => {
    const contact = contactByUser.get(sub.user_id);
    const profile = profileByUser.get(sub.user_id);
    const actions = (actionIdsBySubscription.get(subscriptionKey(sub.user_id, sub.cohort_id)) ?? [])
      .map((id) => actionMap.get(id))
      .filter((action): action is ReminderAction => Boolean(action))
      .sort((left, right) => (left.planOrder ?? Number.MAX_SAFE_INTEGER) - (right.planOrder ?? Number.MAX_SAFE_INTEGER));
    const blockedReason = !sub.whatsapp_reminders_enabled
      ? "WhatsApp is off for this plan."
      : !contact
        ? "No WhatsApp number saved."
        : contact.opted_out_at
          ? "Replied STOP on WhatsApp."
          : !actions.length
            ? "No current actions to include."
            : null;
    return {
      sub,
      fullName: (profile?.full_name as string | null) ?? null,
      phone: (contact?.phone as string | undefined) ?? null,
      optedOut: !!contact?.opted_out_at,
      cohortName: cohortNameMap.get(sub.cohort_id) ?? null,
      companyName: companyByCohortId.get(sub.cohort_id)?.name ?? null,
      actions,
      blockedReason,
    };
  });
}

/** Sends one prepared reminder (caller checks blockedReason first). */
export async function sendPreparedWhatsAppReminder(
  prepared: PreparedWhatsAppReminder,
  purpose: "action_reminder" | "action_reminder_manual"
): Promise<{ result: WhatsAppSendResult; templateName: string }> {
  const { template, components } = buildActionReminder({
    firstName: prepared.fullName?.trim().split(/\s+/)[0] ?? null,
    companyName: prepared.companyName,
    track: prepared.sub.track,
    actions: prepared.actions.map((action) => ({ id: action.id, title: action.title })),
  });
  const result = await sendWhatsAppTemplate({
    to: prepared.phone ?? "",
    template,
    components,
    userId: prepared.sub.user_id,
    purpose,
  });
  return { result, templateName: template.name };
}

/** Sends one prepared Friday recap (caller checks blockedReason first). */
export async function sendPreparedWhatsAppRecap(
  prepared: PreparedWhatsAppReminder,
  purpose: "weekly_recap" | "weekly_recap_manual"
): Promise<{ result: WhatsAppSendResult; templateName: string }> {
  const { template, components } = buildWeeklyRecap({
    firstName: prepared.fullName?.trim().split(/\s+/)[0] ?? null,
    companyName: prepared.companyName,
    actions: prepared.actions.map((action) => ({ id: action.id, title: action.title })),
  });
  const result = await sendWhatsAppTemplate({
    to: prepared.phone ?? "",
    template,
    components,
    userId: prepared.sub.user_id,
    purpose,
  });
  return { result, templateName: template.name };
}

export type WhatsAppReminderRunSummary = {
  configured: boolean;
  sent: number;
  failed: number;
  /** Fridays with the recap on: the recap goes out instead. */
  replacedByRecap: boolean;
  skippedNotDue: number;
  skippedNoNumber: number;
  skippedOptedOut: number;
  skippedEmpty: number;
  skippedClaimed: number;
};

export async function sendWhatsAppActionReminders(): Promise<WhatsAppReminderRunSummary> {
  const summary: WhatsAppReminderRunSummary = {
    configured: isWhatsAppSendConfigured(),
    sent: 0,
    failed: 0,
    replacedByRecap: false,
    skippedNotDue: 0,
    skippedNoNumber: 0,
    skippedOptedOut: 0,
    skippedEmpty: 0,
    skippedClaimed: 0,
  };
  if (!summary.configured) return summary;

  const admin = createAdminClient();
  const todayIST = getCurrentISTDate();
  const todayWeekday = getWeekdayIST(todayIST);
  if (todayWeekday === RECAP_WEEKDAY && isWhatsAppRecapEnabled()) return { ...summary, replacedByRecap: true };

  const { data: subscriptionRows, error: subscriptionError } = await admin
    .from("personal_action_subscriptions")
    .select(WHATSAPP_REMINDER_SUBSCRIPTION_COLUMNS)
    .eq("is_active", true)
    .eq("whatsapp_reminders_enabled", true)
    .is("archived_at", null)
    .not("cohort_id", "is", null);
  if (subscriptionError) {
    console.error("[whatsapp-reminders] failed to load subscriptions", subscriptionError.message);
    return { ...summary, failed: 1 };
  }

  const dueToday = ((subscriptionRows ?? []) as WhatsAppReminderSubscription[]).filter((sub) => {
    const due = reminderDaysFor(sub).includes(todayWeekday);
    if (!due) summary.skippedNotDue += 1;
    return due;
  });
  if (!dueToday.length) return summary;

  let prepared: PreparedWhatsAppReminder[];
  try {
    prepared = await prepareWhatsAppReminders(admin, dueToday);
  } catch (error) {
    console.error("[whatsapp-reminders] failed to prepare reminders", error);
    return { ...summary, failed: dueToday.length };
  }

  for (const reminder of prepared) {
    if (!reminder.phone) {
      summary.skippedNoNumber += 1;
      continue;
    }
    if (reminder.optedOut) {
      summary.skippedOptedOut += 1;
      continue;
    }
    if (reminder.blockedReason) {
      summary.skippedEmpty += 1;
      continue;
    }

    const { sub } = reminder;
    const { data: claimId, error: claimError } = await admin.rpc("claim_whatsapp_reminder", {
      p_subscription_id: sub.id,
      p_user_id: sub.user_id,
      p_cohort_id: sub.cohort_id,
      p_reminder_date: todayIST,
    });
    if (claimError) {
      console.error("[whatsapp-reminders] failed to claim reminder", { subscriptionId: sub.id, error: claimError.message });
      summary.failed += 1;
      continue;
    }
    if (!claimId) {
      summary.skippedClaimed += 1;
      continue;
    }

    const { result, templateName } = await sendPreparedWhatsAppReminder(reminder, "action_reminder");
    const now = new Date().toISOString();
    await admin
      .from("whatsapp_reminder_claims")
      .update({
        status: result.ok ? "sent" : "failed",
        wamid: result.ok ? result.wamid : null,
        template_name: templateName,
        action_count: reminder.actions.length,
        last_error: result.ok ? null : result.error,
        sent_at: result.ok ? now : null,
        updated_at: now,
      })
      .eq("id", String(claimId));

    if (result.ok) {
      summary.sent += 1;
    } else {
      summary.failed += 1;
      console.error("[whatsapp-reminders] send failed", { subscriptionId: sub.id, error: result.error });
    }
  }

  return summary;
}

export type WhatsAppRecapRunSummary = {
  configured: boolean;
  enabled: boolean;
  sent: number;
  failed: number;
  skippedNoNumber: number;
  skippedOptedOut: number;
  skippedEmpty: number;
  skippedClaimed: number;
};

/**
 * Sends the Friday recap to every active plan with WhatsApp on. Runs from the
 * weekly-recap cron on Friday and from the daily cron on Saturday, as a
 * catch-up for failed or missed sends; on other days it does nothing. Claims
 * are per plan per Friday, so a plan already sent is skipped.
 */
export async function sendWhatsAppWeeklyRecap(): Promise<WhatsAppRecapRunSummary> {
  const summary: WhatsAppRecapRunSummary = {
    configured: isWhatsAppSendConfigured(),
    enabled: isWhatsAppRecapEnabled(),
    sent: 0,
    failed: 0,
    skippedNoNumber: 0,
    skippedOptedOut: 0,
    skippedEmpty: 0,
    skippedClaimed: 0,
  };
  const recapDate = whatsappRecapDate(getCurrentISTDate());
  if (!summary.configured || !summary.enabled || !recapDate) return summary;

  const admin = createAdminClient();
  const { data: subscriptionRows, error: subscriptionError } = await admin
    .from("personal_action_subscriptions")
    .select(WHATSAPP_REMINDER_SUBSCRIPTION_COLUMNS)
    .eq("is_active", true)
    .eq("whatsapp_reminders_enabled", true)
    .is("archived_at", null)
    .not("cohort_id", "is", null);
  if (subscriptionError) {
    console.error("[whatsapp-recap] failed to load subscriptions", subscriptionError.message);
    return { ...summary, failed: 1 };
  }

  const subs = (subscriptionRows ?? []) as WhatsAppReminderSubscription[];
  let prepared: PreparedWhatsAppReminder[];
  try {
    prepared = await prepareWhatsAppReminders(admin, subs);
  } catch (error) {
    console.error("[whatsapp-recap] failed to prepare recaps", error);
    return { ...summary, failed: subs.length };
  }

  for (const recap of prepared) {
    if (!recap.phone) {
      summary.skippedNoNumber += 1;
      continue;
    }
    if (recap.optedOut) {
      summary.skippedOptedOut += 1;
      continue;
    }
    if (recap.blockedReason) {
      summary.skippedEmpty += 1;
      continue;
    }

    const { sub } = recap;
    const { data: claimId, error: claimError } = await admin.rpc("claim_whatsapp_recap", {
      p_subscription_id: sub.id,
      p_user_id: sub.user_id,
      p_cohort_id: sub.cohort_id,
      p_recap_date: recapDate,
    });
    if (claimError) {
      console.error("[whatsapp-recap] failed to claim recap", { subscriptionId: sub.id, error: claimError.message });
      summary.failed += 1;
      continue;
    }
    if (!claimId) {
      summary.skippedClaimed += 1;
      continue;
    }

    const { result, templateName } = await sendPreparedWhatsAppRecap(recap, "weekly_recap");
    const now = new Date().toISOString();
    await admin
      .from("whatsapp_recap_claims")
      .update({
        status: result.ok ? "sent" : "failed",
        wamid: result.ok ? result.wamid : null,
        template_name: templateName,
        action_count: recap.actions.length,
        last_error: result.ok ? null : result.error,
        sent_at: result.ok ? now : null,
        updated_at: now,
      })
      .eq("id", String(claimId));

    if (result.ok) {
      summary.sent += 1;
    } else {
      summary.failed += 1;
      console.error("[whatsapp-recap] send failed", { subscriptionId: sub.id, error: result.error });
    }
  }

  return summary;
}
