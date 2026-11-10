"use server";

import { after } from "next/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionTheme } from "@/lib/types";
import {
  assignScheduledBatch,
  computeNextDeliveryAt,
  computeTotalActionsNeeded,
  advanceNextDeliveryAt,
  getWeekdayIST,
  BACKGROUND_BATCH_SIZE,
  buildTrainingContext,
  DAILY_DELIVERY_DAYS,
  MAX_WEEKLY_ACTIONS,
  draftsToActionRows,
  generateDraftActions,
  type DeliveryTrack,
} from "@/lib/personal-action-generation";
import { getCurrentISTDate, istToUTCTime, utcToISTDate, utcToISTTime } from "@/lib/timezone-utils";
import { getMyCohorts } from "@/app/actions/cohorts";
import { createAdminClient } from "@/lib/supabase/admin";
import { isResendConfigured, resend } from "@/lib/resend";
import { renderEmailTemplate, formatPlanActionDate } from "@/lib/email-templates";
import { buildFromHeader } from "@/lib/email-send";
import { buildActionPlanPdf } from "@/lib/action-plan-pdf";
import { matchActionImagesForRows } from "@/lib/action-image-matching";
import { matchActionCategory, parseActionCategories } from "@/lib/action-categories";
import { assignSurpriseResourcesForPlan } from "@/lib/surprise-resource-assignment";
import { saveWhatsAppNumber } from "@/lib/whatsapp-contact-store";

export type MyPlanSettings = {
  track: DeliveryTrack;
  actionCount: number;
  durationWeeks: number;
  daysOfWeek: number[];
  reminderTime: string;
  totalActionsPlanned: number;
  nextDeliveryAt: string | null;
  emailRemindersEnabled: boolean;
  isActive: boolean;
  isArchived: boolean;
};

export type DraftPlanScheduleSlot = {
  plannedAt: string;
  isImmediate: boolean;
  batchNumber: number;
};

async function getSelectedPlanCohort(requireCurrent = false, knownCohortId?: string): Promise<{ cohortId?: string; maxWeeks?: number | null; error?: string }> {
  // Callers that already resolved their own selected cohort this render (e.g. from
  // useEngine()) can pass it straight through and skip re-deriving it from scratch,
  // which is a ~6-7 query operation inside getMyCohorts(). Only skip when the caller
  // doesn't need the isCurrent check, since that requires the full cohort list.
  if (knownCohortId && !requireCurrent) return { cohortId: knownCohortId };
  const context = await getMyCohorts();
  if (context.error) return { error: context.error };
  const selected = context.cohorts.find((cohort) => cohort.isSelected);
  if (!selected) return { error: "Select a batch first" };
  if (requireCurrent && !selected.isCurrent) return { error: "New plans can only be built for your current batch" };
  return { cohortId: selected.id, maxWeeks: selected.maxWeeks };
}

export async function getMyPlanSettings(knownCohortId?: string): Promise<{ settings: MyPlanSettings | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { settings: null, error: "Not authenticated" };
  const cohortContext = await getSelectedPlanCohort(false, knownCohortId);
  if (!cohortContext.cohortId) return { settings: null, error: cohortContext.error };
  const { data, error } = await supabase.from("personal_action_subscriptions")
    .select("track, daily_action_count, duration_weeks, days_of_week, day_of_week, time_of_day_utc, total_actions_planned, next_delivery_at, email_reminders_enabled, is_active, archived_at")
    .eq("user_id", user.id)
    .eq("cohort_id", cohortContext.cohortId)
    .maybeSingle();
  if (error) return { settings: null, error: error.message };
  if (!data) return { settings: null };
  return { settings: {
    track: data.track as DeliveryTrack,
    actionCount: data.track === "daily" ? 1 : data.daily_action_count ?? 1,
    durationWeeks: data.duration_weeks ?? 0,
    daysOfWeek: data.days_of_week ?? (data.day_of_week != null ? [data.day_of_week] : []),
    reminderTime: utcToISTTime(data.time_of_day_utc),
    totalActionsPlanned: data.total_actions_planned ?? 0,
    nextDeliveryAt: data.next_delivery_at ?? null,
    emailRemindersEnabled: data.email_reminders_enabled !== false,
    isActive: data.is_active === true,
    isArchived: !!data.archived_at,
  } };
}

/**
 * Release today's due personal-action batch for the selected cohort.
 * Delivery normally waits for the daily cron, but Next reminders already show
 * the IST calendar date. Syncing on the Actions page closes that gap so due
 * actions appear under Current actions without waiting for 11:30 AM IST.
 */
export async function syncMyDuePersonalActions(knownCohortId?: string): Promise<{ assigned: number; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { assigned: 0, error: "Not authenticated" };
    const cohortContext = await getSelectedPlanCohort(false, knownCohortId);
    if (!cohortContext.cohortId) return { assigned: 0, error: cohortContext.error };

    const { data: sub, error } = await supabase
      .from("personal_action_subscriptions")
      .select("id, user_id, cohort_id, track, day_of_week, days_of_week, daily_action_count, time_of_day_utc, next_delivery_at, is_active, archived_at")
      .eq("user_id", user.id)
      .eq("cohort_id", cohortContext.cohortId)
      .maybeSingle();
    if (error) return { assigned: 0, error: error.message };
    if (!sub || !sub.is_active || sub.archived_at) return { assigned: 0 };

    const deliveryDay = utcToISTDate(sub.next_delivery_at);
    const todayIST = getCurrentISTDate();
    if (!deliveryDay || deliveryDay > todayIST) return { assigned: 0 };

    const { assigned } = await assignScheduledBatch(sub);
    return { assigned };
  } catch (e) {
    return { assigned: 0, error: e instanceof Error ? e.message : "Failed to sync due actions" };
  }
}

/** Preview the release slots a reviewed draft will use when it is finalised. */
export async function getDraftPlanSchedule(): Promise<{
  slots: DraftPlanScheduleSlot[];
  actionCountPerRelease: number;
  error?: string;
}> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { slots: [], actionCountPerRelease: 1, error: "Not authenticated" };
    const cohortContext = await getSelectedPlanCohort(true);
    if (!cohortContext.cohortId) return { slots: [], actionCountPerRelease: 1, error: cohortContext.error };

    const [{ data: subscription, error: subscriptionError }, { count, error: actionError }] = await Promise.all([
      supabase
        .from("personal_action_subscriptions")
        .select("track, day_of_week, days_of_week, daily_action_count, time_of_day_utc, is_active, archived_at")
        .eq("user_id", user.id)
        .eq("cohort_id", cohortContext.cohortId)
        .maybeSingle(),
      supabase
        .from("actions")
        .select("id", { count: "exact", head: true })
        .eq("created_by", user.id)
        .eq("cohort_id", cohortContext.cohortId)
        .eq("is_personal", true),
    ]);
    if (subscriptionError || actionError) {
      return { slots: [], actionCountPerRelease: 1, error: subscriptionError?.message ?? actionError?.message };
    }
    if (!subscription || subscription.is_active || subscription.archived_at) {
      return { slots: [], actionCountPerRelease: 1, error: "Only draft plans have a schedule preview" };
    }

    const actionCountPerRelease = subscription.track === "daily"
      ? 1
      : Math.max(1, subscription.daily_action_count ?? 1);
    const daysOfWeek = subscription.days_of_week ?? (subscription.day_of_week != null ? [subscription.day_of_week] : null);
    const firstCadenceAt = computeNextDeliveryAt(
      subscription.track as DeliveryTrack,
      daysOfWeek,
      subscription.time_of_day_utc
    );
    const releaseDates: string[] = [];
    let nextRelease = firstCadenceAt;
    const batchCount = Math.ceil((count ?? 0) / actionCountPerRelease);
    // The first batch is released at activation; the rest follow the chosen
    // cadence (next weekday for daily plans, next selected weekday for weekly).
    // Daily plans activated on a weekend wait for the next weekday instead.
    const firstIsImmediate = subscription.track !== "daily"
      || (DAILY_DELIVERY_DAYS as readonly number[]).includes(getWeekdayIST(getCurrentISTDate()));
    if (firstIsImmediate && batchCount > 0) releaseDates.push(new Date().toISOString());
    for (let batchIndex = releaseDates.length; batchIndex < batchCount; batchIndex += 1) {
      releaseDates.push(nextRelease);
      nextRelease = advanceNextDeliveryAt(
        nextRelease,
        subscription.track as DeliveryTrack,
        daysOfWeek,
        subscription.time_of_day_utc
      );
    }

    return {
      actionCountPerRelease,
      slots: Array.from({ length: count ?? 0 }, (_, index) => {
        const batchNumber = Math.floor(index / actionCountPerRelease) + 1;
        return {
          plannedAt: releaseDates[batchNumber - 1],
          isImmediate: firstIsImmediate && batchNumber === 1,
          batchNumber,
        };
      }),
    };
  } catch (error) {
    return {
      slots: [],
      actionCountPerRelease: 1,
      error: error instanceof Error ? error.message : "Failed to preview the plan schedule",
    };
  }
}

/**
 * Save a draft plan and generate its actions in the background. The subscription
 * remains inactive until the participant reviews the actions and explicitly
 * finalises the plan with activatePersonalActionPlan.
 */
export async function saveGeneratedActions(params: {
  userNotes: string;
  focusThemes: ActionTheme[];
  focusCustomText?: string;
  track: DeliveryTrack;
  /** Actions generated per delivery (weekly plans: 1–MAX_WEEKLY_ACTIONS). */
  dailyActionCount: 1 | 2 | 3;
  /** 0 = Sunday, ... 6 = Saturday. Multiple allowed for "daily", exactly one for "weekly". */
  daysOfWeek: number[];
  /** Length of the plan in weeks (2-24). Drives how many total actions get generated. */
  durationWeeks: number;
  /** Whether action reminders should also be delivered by email. */
  emailRemindersEnabled: boolean;
  /** "Send my reminders on WhatsApp" — ticked by default in plan setup. */
  whatsappRemindersEnabled?: boolean;
  /** The number shown next to that checkbox (admin's default, possibly edited). */
  whatsappNumber?: string;
}): Promise<{ error?: string; totalActionsNeeded?: number }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return { error: "Not authenticated" };
    }

    const cohortContext = await getSelectedPlanCohort(true);
    if (!cohortContext.cohortId) return { error: cohortContext.error };
    const cohortId = cohortContext.cohortId;

    const { data: profile } = await supabase
      .from("profiles")
      .select("company_id")
      .eq("id", user.id)
      .single();
    const companyId = profile?.company_id;
    if (!companyId) {
      return { error: "You must be assigned to a company first" };
    }

    const { data: existingPlan } = await supabase
      .from("personal_action_subscriptions")
      .select("is_active, archived_at")
      .eq("user_id", user.id)
      .eq("cohort_id", cohortId)
      .maybeSingle();
    if (existingPlan?.is_active || existingPlan?.archived_at) {
      return { error: "This batch plan has already been finalised and cannot be edited" };
    }

    if (params.track !== "daily" && params.track !== "weekly") {
      return { error: "Invalid track" };
    }
    // Daily plans run Monday-Friday. Weekly plans use exactly one chosen reminder day.
    const uniqueDays = params.track === "daily"
      ? [...DAILY_DELIVERY_DAYS]
      : [...new Set(params.daysOfWeek ?? [])].sort((a, b) => a - b);
    if (!uniqueDays.length || uniqueDays.some((d) => d < 0 || d > 6)) {
      return { error: "Select at least one day" };
    }
    if (params.track === "weekly" && uniqueDays.length !== 1) {
      return { error: "Weekly sprint requires exactly one day" };
    }
    if (!Number.isInteger(params.dailyActionCount) || params.dailyActionCount < 1 || params.dailyActionCount > MAX_WEEKLY_ACTIONS) {
      return { error: `Action count must be between 1 and ${MAX_WEEKLY_ACTIONS}` };
    }
    const actionCount = params.track === "daily" ? 1 : params.dailyActionCount;
    const effectiveMaxWeeks = Math.min(cohortContext.maxWeeks ?? 24, 24);
    if (!Number.isInteger(params.durationWeeks) || params.durationWeeks < 2 || params.durationWeeks > effectiveMaxWeeks) {
      return { error: `Plan duration must be between 2 and ${effectiveMaxWeeks} weeks` };
    }

    // Save the number first so an invalid/duplicate number is reported before
    // any draft or generation job is touched. Ticking the box is an explicit
    // opt-in, so it also clears an earlier STOP.
    const whatsappAvailable = !!process.env.WHATSAPP_PHONE_NUMBER_ID;
    const whatsappEnabled = whatsappAvailable && params.whatsappRemindersEnabled === true;
    if (whatsappEnabled) {
      if (!params.whatsappNumber?.trim()) {
        return { error: "Enter your WhatsApp number, or untick WhatsApp reminders" };
      }
      const admin = createAdminClient();
      const saved = await saveWhatsAppNumber(admin, {
        userId: user.id,
        rawNumber: params.whatsappNumber,
        source: "participant",
        updatedBy: user.id,
      });
      if (saved.error) return { error: saved.error };
      const { error: optInError } = await admin
        .from("whatsapp_contacts")
        .update({ opted_out_at: null, updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
      if (optInError) return { error: optInError.message };
    }

    const contextText = buildTrainingContext(params.userNotes, params.focusThemes, params.focusCustomText);
    // The free Vercel cron runs once daily at 11:30 AM IST. Enforce that
    // server-side so older or custom clients cannot submit an unsupported time.
    const timeOfDayUtc = istToUTCTime("11:30");
    // A pinned opener (e.g. Surge's Teach-Back action) fills slot 0 of the
    // plan the participant configured — it is one of their chosen actions,
    // not an extra one on top, so the total stays exactly what they picked.
    const totalActionsNeeded = computeTotalActionsNeeded(
      params.durationWeeks,
      actionCount,
      params.track,
      uniqueDays
    );

    // Changing a draft replaces that cohort's unfinished generation rather
    // than mixing two different setup choices into one plan.
    if (existingPlan) {
      await supabase
        .from("personal_action_generation_jobs")
        .update({ status: "failed", error_message: "Replaced by a newer draft", updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("cohort_id", cohortId)
        .eq("status", "generating");
      await supabase
        .from("actions")
        .delete()
        .eq("created_by", user.id)
        .eq("cohort_id", cohortId)
        .eq("is_personal", true);
    }

    // Draft only: no actions are delivered until the participant reviews and
    // activates the plan.
    const { error: subError } = await supabase.from("personal_action_subscriptions").upsert(
      {
        user_id: user.id,
        cohort_id: cohortId,
        training_text: contextText,
        focus_themes: params.focusThemes,
        track: params.track,
        day_of_week: uniqueDays[0],
        days_of_week: uniqueDays,
        daily_action_count: actionCount,
        time_of_day_utc: timeOfDayUtc,
        is_active: false,
        last_delivered_at: null,
        next_delivery_at: computeNextDeliveryAt(params.track, uniqueDays, timeOfDayUtc),
        duration_weeks: params.durationWeeks,
        total_actions_planned: totalActionsNeeded,
        email_reminders_enabled: params.emailRemindersEnabled,
        whatsapp_reminders_enabled: whatsappEnabled,
        whatsapp_opted_in_at: whatsappEnabled ? new Date().toISOString() : null,
        last_reminder_sent_date: null,
      },
      { onConflict: "user_id,cohort_id" }
    );
    if (subError) {
      return { error: subError.message };
    }

    const { data: job, error: jobError } = await supabase
      .from("personal_action_generation_jobs")
      .insert({
        user_id: user.id,
        cohort_id: cohortId,
        training_text: contextText,
        focus_themes: params.focusThemes,
        total_needed: totalActionsNeeded,
        total_generated: 0,
        batch_size: BACKGROUND_BATCH_SIZE,
        status: "generating",
      })
      .select("id")
      .single();

    if (jobError || !job?.id) {
      return { error: jobError?.message ?? "Could not start action generation" };
    }

    {
      // Derive origin from the actual incoming request (not NEXT_PUBLIC_APP_URL,
      // which points at production and would misfire this self-trigger when
      // running locally or on a preview deployment).
      const hdrs = await headers();
      const host = hdrs.get("host");
      const proto = hdrs.get("x-forwarded-proto") ?? (host?.startsWith("localhost") || host?.startsWith("127.0.0.1") ? "http" : "https");
      const origin = host ? `${proto}://${host}` : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const cronSecret = process.env.CRON_SECRET;
      after(async () => {
        try {
          const res = await fetch(`${origin}/api/generate-actions-batch`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}),
            },
            body: JSON.stringify({ jobId: job.id }),
          });
          const contentType = res.headers.get("content-type") ?? "";
          const payload = contentType.includes("application/json")
            ? await res.json() as { ok?: boolean; error?: string }
            : null;
          if (!res.ok || !payload || payload.ok !== true) {
            const failure = payload?.error
              ?? (!contentType.includes("application/json")
                ? "Generation endpoint returned an unexpected response"
                : `Failed to start generation (HTTP ${res.status})`);
            await supabase
              .from("personal_action_generation_jobs")
              .update({ status: "failed", error_message: failure, updated_at: new Date().toISOString() })
              .eq("id", job.id)
              .eq("status", "generating");
          }
        } catch (e) {
          await supabase
            .from("personal_action_generation_jobs")
            .update({
              status: "failed",
              error_message: `Failed to reach ${origin}: ${e instanceof Error ? e.message : String(e)}`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id)
            .eq("status", "generating");
        }
      });
    }

    return { totalActionsNeeded };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save actions" };
  }
}

/**
 * Emails the participant a summary of their just-finalised plan: every
 * action with its projected delivery date, their commitment buddy's name
 * and email (pairing this triggers if it hasn't happened yet), and the
 * reminder cadence they'll now receive. Never throws — a failure here must
 * not undo a successful activation, so all errors are swallowed and logged.
 */
async function sendPlanActivatedSummaryEmail(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  userEmail: string;
  cohortId: string;
  sub: {
    track: DeliveryTrack;
    day_of_week: number | null;
    days_of_week: number[] | null;
    daily_action_count: number;
    time_of_day_utc: string;
  };
  nextDeliveryAt: string;
  /** The first batch was released at activation, before nextDeliveryAt. */
  firstBatchReleasedNow?: boolean;
}): Promise<void> {
  const { supabase, userId, userEmail, cohortId, sub, nextDeliveryAt, firstBatchReleasedNow } = params;
  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL;
    if (!fromEmail) return;

    const [{ data: profile }, { data: actionRows }, { data: cohort }, { data: notesRow }] = await Promise.all([
      supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
      supabase
        .from("actions")
        .select("title, plan_order, image_url")
        .eq("created_by", userId)
        .eq("cohort_id", cohortId)
        .eq("is_personal", true)
        .order("plan_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true }),
      supabase.from("cohorts").select("company_id, trainer_id, batch_name, module_name").eq("id", cohortId).maybeSingle(),
      supabase
        .from("participant_session_notes")
        .select("daily_work, skill_goal, practice_opportunities")
        .eq("user_id", userId)
        .eq("cohort_id", cohortId)
        .maybeSingle(),
    ]);

    // Same combination notes-client.tsx uses for its read-only "My Plan" view
    // (daily work + skill goal as one paragraph, practice opportunities as a
    // second) — capped so one very long free-text answer can't blow up the
    // email's Gmail-clipping budget or balloon the PDF into dozens of pages.
    const PLAN_TEXT_LIMIT = 1500;
    const workAndSkill = [notesRow?.daily_work, notesRow?.skill_goal]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean)
      .join(" ");
    const practiceOpportunities = typeof notesRow?.practice_opportunities === "string"
      ? notesRow.practice_opportunities.trim()
      : "";
    let planText = [workAndSkill, practiceOpportunities].filter(Boolean).join("\n\n");
    if (planText.length > PLAN_TEXT_LIMIT) {
      planText = `${planText.slice(0, PLAN_TEXT_LIMIT).trimEnd()}…`;
    }

    const firstName =
      (profile?.full_name ?? "").trim().split(/\s+/)[0] || userEmail.split("@")[0] || "there";

    // Project each action's delivery date with the same cadence
    // assignScheduledBatch() uses to release them for real: one action per
    // weekday for daily plans, daily_action_count actions per cycle for
    // weekly ones — so the dates shown here match what actually happens.
    // When the first batch went out at activation it is dated today and the
    // second batch lands on nextDeliveryAt.
    const daysOfWeek = sub.days_of_week ?? (sub.day_of_week != null ? [sub.day_of_week] : null);
    const batchSize = sub.track === "daily" ? 1 : Math.max(1, sub.daily_action_count ?? 1);
    let cursor = firstBatchReleasedNow ? new Date().toISOString() : nextDeliveryAt;
    const actions = (actionRows ?? []).map((row, index) => {
      if (index > 0 && index % batchSize === 0) {
        cursor = firstBatchReleasedNow && index === batchSize
          ? nextDeliveryAt
          : advanceNextDeliveryAt(cursor, sub.track, daysOfWeek, sub.time_of_day_utc);
      }
      return { title: row.title as string, date: utcToISTDate(cursor), imageUrl: (row.image_url as string | null) ?? undefined };
    });

    let companyName = "";
    let companyLogo = "";
    let senderName = "Nudgeable";
    let trainerName = "";
    if (cohort?.company_id) {
      const { data: company } = await supabase
        .from("companies")
        .select("name, logo_url")
        .eq("id", cohort.company_id)
        .maybeSingle();
      companyName = company?.name ?? "";
      companyLogo = company?.logo_url ?? "";
    }
    if (cohort?.trainer_id) {
      const { data: trainer } = await supabase
        .from("trainers")
        .select("name")
        .eq("id", cohort.trainer_id)
        .maybeSingle();
      if (trainer?.name) {
        senderName = trainer.name;
        trainerName = trainer.name;
      }
    }
    const batchName = (cohort as { batch_name?: string | null } | null)?.batch_name ?? "";
    const moduleName = (cohort as { module_name?: string | null } | null)?.module_name ?? "";

    // Reuses the same RPC the Actions page calls — it both creates this
    // participant's stable buddy pair/trio if one isn't assigned yet (now
    // possible since the plan is active) and returns the buddy's name.
    // Email isn't exposed by the RPC (by design, see 041_commitment_buddies),
    // so it's looked up separately with the admin client.
    let buddyName = "";
    let buddyEmail = "";
    const { data: buddyGroup } = await supabase.rpc("get_my_commitment_buddies", { p_cohort_id: cohortId });
    const firstBuddy = (buddyGroup as { buddies?: Array<{ id?: string; name?: string }> } | null)?.buddies?.[0];
    if (firstBuddy?.id) {
      buddyName = firstBuddy.name ?? "";
      const admin = createAdminClient();
      const { data: buddyProfile } = await admin
        .from("profiles")
        .select("email")
        .eq("id", firstBuddy.id)
        .maybeSingle();
      buddyEmail = buddyProfile?.email ?? "";
    }

    const { subject, html } = renderEmailTemplate("plan_activated_summary", {
      first_name: firstName,
      company_name: companyName,
      company_logo: companyLogo,
      reminder_frequency: sub.track,
      buddy_name: buddyName,
      buddy_email: buddyEmail,
      plan_text: planText,
      actions,
    });

    // The email body shows only the first 6 actions and says so explicitly,
    // pointing to the PDF for the rest; the PDF has no such constraint, so it
    // always carries the complete ordered plan.
    const pdfBuffer = await buildActionPlanPdf({
      firstName,
      companyName,
      companyLogo,
      batchName,
      moduleName,
      trainerName,
      buddyName,
      buddyEmail,
      planText,
      reminderFrequency: sub.track,
      actions: actions.map((action) => ({ title: action.title, date: formatPlanActionDate(action.date) })),
    });

    const { error: sendError } = await resend.emails.send({
      to: userEmail,
      from: buildFromHeader(fromEmail, senderName),
      subject,
      html,
      attachments: [
        {
          filename: "your-action-plan.pdf",
          content: pdfBuffer,
        },
      ],
    });
    if (sendError) throw new Error(sendError.message);
  } catch (e) {
    console.error("[activatePersonalActionPlan] failed sending plan summary email", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Finalise a reviewed draft and activate its future delivery cadence. */
export async function activatePersonalActionPlan(): Promise<{ error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Not authenticated" };
    const cohortContext = await getSelectedPlanCohort(true);
    if (!cohortContext.cohortId) return { error: cohortContext.error };

    const { data: sub, error } = await supabase
      .from("personal_action_subscriptions")
      .select("id, user_id, cohort_id, track, day_of_week, days_of_week, daily_action_count, time_of_day_utc, next_delivery_at, archived_at")
      .eq("user_id", user.id)
      .eq("cohort_id", cohortContext.cohortId)
      .maybeSingle();
    if (error || !sub) return { error: error?.message ?? "Create a plan first" };
    if (sub.archived_at) return { error: "Archived plans cannot be reactivated" };

    const nextDeliveryAt = computeNextDeliveryAt(
      sub.track as DeliveryTrack,
      sub.days_of_week ?? (sub.day_of_week != null ? [sub.day_of_week] : null),
      sub.time_of_day_utc
    );
    const { error: activationError } = await supabase.rpc("activate_my_commitment_wallet_plan", {
      p_cohort_id: cohortContext.cohortId,
      p_next_delivery_at: nextDeliveryAt,
    });
    if (activationError) return { error: activationError.message };

    // Release the first batch right away so the participant starts practising
    // today. next_delivery_at stays on the next cadence day, which brings the
    // second batch. (Daily plans activated on a weekend still wait for Monday.)
    const { assigned: releasedNow } = await assignScheduledBatch(
      { ...sub, track: sub.track as DeliveryTrack, next_delivery_at: nextDeliveryAt },
      { advanceCadence: false }
    );

    await supabase.from("profiles").update({ self_onboarding_completed_at: new Date().toISOString() }).eq("id", user.id);

    // Give each frozen action a random Surprise Box resource. Background and
    // best-effort: an unassigned action still gets a resource at unlock time.
    const assignAdmin = createAdminClient();
    const assignCohortId = cohortContext.cohortId;
    after(() => assignSurpriseResourcesForPlan(assignAdmin, { userId: user.id, cohortId: assignCohortId }));

    // Deferred to after the response so the participant isn't kept waiting
    // on buddy pairing, multiple lookups, and a Resend call before their
    // "Activate My Plan" click redirects them to /actions.
    if (isResendConfigured() && user.email) {
      const userEmail = user.email;
      after(() =>
        sendPlanActivatedSummaryEmail({
          supabase,
          userId: user.id,
          userEmail,
          cohortId: cohortContext.cohortId!,
          sub: {
            track: sub.track as DeliveryTrack,
            day_of_week: sub.day_of_week,
            days_of_week: sub.days_of_week,
            daily_action_count: sub.daily_action_count,
            time_of_day_utc: sub.time_of_day_utc,
          },
          nextDeliveryAt,
          firstBatchReleasedNow: releasedNow > 0,
        })
      );
    }

    revalidatePath("/wallet");
    revalidatePath("/surprises");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to activate plan" };
  }
}

/** Dismiss the self-serve onboarding wizard without generating any actions. */
export async function skipSelfOnboarding(): Promise<{ error?: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return { error: "Not authenticated" };
    }

    await supabase
      .from("profiles")
      .update({ self_onboarding_completed_at: new Date().toISOString() })
      .eq("id", user.id);

    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

/**
 * Latest background action-plan generation job for the current user, for live status polling.
 * Accepts the caller's already-resolved cohort id — this is polled every 3-12s for as long as a
 * page is open, so re-deriving the cohort from scratch (~7 queries via getMyCohorts()) on every
 * single poll was a real, recurring cost, not just a one-time page-load one.
 */
export async function getActiveGenerationJob(knownCohortId?: string): Promise<{
  job: { id: string; totalNeeded: number; totalGenerated: number; status: string; errorMessage?: string } | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { job: null };
  }
  const cohortContext = await getSelectedPlanCohort(false, knownCohortId);
  if (!cohortContext.cohortId) return { job: null };

  const { data } = await supabase
    .from("personal_action_generation_jobs")
    .select("id, total_needed, total_generated, status, error_message")
    .eq("user_id", user.id)
    .eq("cohort_id", cohortContext.cohortId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    return { job: null };
  }

  return {
    job: {
      id: data.id,
      totalNeeded: data.total_needed,
      totalGenerated: data.total_generated,
      status: data.status,
      errorMessage: data.error_message ?? undefined,
    },
  };
}

/** Persist the exact sequence chosen on the draft review screen. */
export async function reorderPersonalActions(actionIds: string[]): Promise<{ error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return { error: "Not authenticated" };
    const cohortContext = await getSelectedPlanCohort(true);
    if (!cohortContext.cohortId) return { error: cohortContext.error };

    const { data: plan } = await supabase
      .from("personal_action_subscriptions")
      .select("is_active, archived_at")
      .eq("user_id", user.id)
      .eq("cohort_id", cohortContext.cohortId)
      .maybeSingle();
    if (!plan || plan.is_active || plan.archived_at) return { error: "Finalised plans are view-only" };

    const { error: reorderError } = await supabase.rpc("reorder_my_draft_personal_actions", {
      p_cohort_id: cohortContext.cohortId,
      p_action_ids: actionIds,
    });
    if (reorderError) return { error: reorderError.message };
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to reorder actions" };
  }
}

/** Edit one of the current user's own AI-generated personal actions (e.g. from the library while generation is still in progress). */
export async function updatePersonalAction(
  id: string,
  params: {
    theme?: ActionTheme;
    title?: string;
    how?: string;
    why?: string;
    timeEstimate?: string;
  }
): Promise<{ error?: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return { error: "Not authenticated" };
    }

    const { data: action } = await supabase
      .from("actions")
      .select("cohort_id")
      .eq("id", id)
      .eq("created_by", user.id)
      .eq("is_personal", true)
      .maybeSingle();
    if (!action?.cohort_id) return { error: "Action not found" };
    const { data: plan } = await supabase
      .from("personal_action_subscriptions")
      .select("is_active, archived_at")
      .eq("user_id", user.id)
      .eq("cohort_id", action.cohort_id)
      .maybeSingle();
    if (!plan || plan.is_active || plan.archived_at) return { error: "Finalised plans are view-only" };

    const updates: Record<string, unknown> = {};
    if (params.theme != null) updates.theme = params.theme;
    if (params.title != null) updates.title = params.title.trim();
    if (params.how != null) updates.how = params.how.trim();
    if (params.why != null) updates.why = params.why.trim();
    if (params.timeEstimate != null) updates.time_estimate = params.timeEstimate;

    const { error } = await supabase
      .from("actions")
      .update(updates)
      .eq("id", id)
      .eq("created_by", user.id)
      .eq("is_personal", true);

    if (error) return { error: error.message };
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update action" };
  }
}

/**
 * Edit the title/how/why of one action in the participant's "Next reminders"
 * list — an already-activated plan's actions that have not yet been
 * delivered into "My Actions" (no user_actions row exists for them yet).
 * Unlike updatePersonalAction (draft-only), this deliberately allows edits
 * after activation, but only for that one still-safe slice: nothing already
 * released, calendar-synced, or in progress can be touched here.
 */
export async function updateUpcomingPersonalAction(
  id: string,
  params: {
    title: string;
    how: string;
    why: string;
    /** One of the batch's action categories. Undefined leaves it unchanged; it can't be cleared. */
    category?: string | null;
  }
): Promise<{ error?: string }> {
  try {
    const title = params.title.trim();
    const how = params.how.trim();
    const why = params.why.trim();
    if (!title || !how || !why) return { error: "Title, how, and why are all required" };

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Not authenticated" };

    const { data: action } = await supabase
      .from("actions")
      .select("id, cohort_id")
      .eq("id", id)
      .eq("created_by", user.id)
      .eq("is_personal", true)
      .maybeSingle();
    if (!action) return { error: "Action not found" };

    const updates: { title: string; how: string; why: string; category?: string | null } = { title, how, why };
    if (params.category !== undefined) {
      // Every action keeps a category, so only accept one of this batch's own.
      const { data: cohortRow } = action.cohort_id
        ? await supabase.from("cohorts").select("action_categories").eq("id", action.cohort_id).maybeSingle()
        : { data: null };
      const category = matchActionCategory(params.category, parseActionCategories(cohortRow?.action_categories));
      if (!category) return { error: "Pick one of this batch's categories" };
      updates.category = category;
    }

    const { data: delivered } = await supabase
      .from("user_actions")
      .select("id")
      .eq("action_id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (delivered) return { error: "This action has already gone out in a reminder and can no longer be edited" };

    const { error } = await supabase
      .from("actions")
      .update(updates)
      .eq("id", id)
      .eq("created_by", user.id)
      .eq("is_personal", true);
    if (error) return { error: error.message };

    revalidatePath("/actions");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update action" };
  }
}

/**
 * Append one extra AI-generated action to a draft plan while the participant
 * is still reviewing/editing. Finalised and archived plans stay view-only.
 */
export async function generateOneMorePersonalAction(): Promise<{ error?: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return { error: "Not authenticated" };

    const cohortContext = await getSelectedPlanCohort(true);
    if (!cohortContext.cohortId) return { error: cohortContext.error };
    const cohortId = cohortContext.cohortId;

    const { data: profile } = await supabase
      .from("profiles")
      .select("company_id")
      .eq("id", user.id)
      .single();
    const companyId = profile?.company_id;
    if (!companyId) return { error: "You must be assigned to a company first" };

    const { data: plan } = await supabase
      .from("personal_action_subscriptions")
      .select("id, training_text, focus_themes, is_active, archived_at, total_actions_planned")
      .eq("user_id", user.id)
      .eq("cohort_id", cohortId)
      .maybeSingle();
    if (!plan) return { error: "Create a plan first" };
    if (plan.is_active || plan.archived_at) return { error: "Finalised plans are view-only" };

    const { data: activeJob } = await supabase
      .from("personal_action_generation_jobs")
      .select("id")
      .eq("user_id", user.id)
      .eq("cohort_id", cohortId)
      .eq("status", "generating")
      .limit(1)
      .maybeSingle();
    if (activeJob) return { error: "Wait for the current generation to finish" };

    const { data: existingActions, error: existingError } = await supabase
      .from("actions")
      .select("title, plan_order")
      .eq("created_by", user.id)
      .eq("cohort_id", cohortId)
      .eq("is_personal", true)
      .order("plan_order", { ascending: false, nullsFirst: false });
    if (existingError) return { error: existingError.message };

    const avoidTitles = (existingActions ?? []).map((action) => action.title).filter(Boolean);
    const nextPlanOrder = ((existingActions ?? [])[0]?.plan_order ?? -1) + 1;
    const focusThemes = (plan.focus_themes ?? []) as ActionTheme[];

    const { data: cohortGenerationContext, error: cohortGenerationContextError } = await supabase
      .from("cohorts")
      .select("training_content, business_context, action_categories")
      .eq("id", cohortId)
      .single();
    if (cohortGenerationContextError) return { error: cohortGenerationContextError.message };

    const { drafts, error: generateError } = await generateDraftActions({
      trainingContent: cohortGenerationContext?.training_content ?? "",
      userNotes: plan.training_text ?? "",
      businessContext: cohortGenerationContext?.business_context ?? "",
      focusThemes,
      count: 1,
      avoidTitles,
      categories: parseActionCategories(cohortGenerationContext?.action_categories),
    });
    if (generateError || !drafts?.length) {
      return { error: generateError ?? "AI did not return an action" };
    }

    const rows = draftsToActionRows(drafts.slice(0, 1), companyId, user.id, cohortId, nextPlanOrder);
    const { data: insertedActions, error: insertError } = await supabase.from("actions").insert(rows).select("id, title, how, why");
    if (insertError) return { error: insertError.message };

    // Best-effort thumbnail match; must never delay this action's response.
    if (insertedActions?.length) {
      const admin = createAdminClient();
      after(() => matchActionImagesForRows(admin, insertedActions));
    }

    const totalActions = (existingActions?.length ?? 0) + 1;
    await supabase
      .from("personal_action_subscriptions")
      .update({
        total_actions_planned: Math.max(plan.total_actions_planned ?? 0, totalActions),
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.id);

    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to generate another action" };
  }
}

/** Delete one of the current user's own AI-generated personal actions from the library. */
export async function deletePersonalAction(id: string): Promise<{ error?: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return { error: "Not authenticated" };
    }

    const { data: action } = await supabase
      .from("actions")
      .select("cohort_id")
      .eq("id", id)
      .eq("created_by", user.id)
      .eq("is_personal", true)
      .maybeSingle();
    if (!action?.cohort_id) return { error: "Action not found" };
    const { data: plan } = await supabase
      .from("personal_action_subscriptions")
      .select("is_active, archived_at")
      .eq("user_id", user.id)
      .eq("cohort_id", action.cohort_id)
      .maybeSingle();
    if (!plan || plan.is_active || plan.archived_at) return { error: "Finalised plans are view-only" };

    const { error } = await supabase
      .from("actions")
      .delete()
      .eq("id", id)
      .eq("created_by", user.id)
      .eq("is_personal", true);

    if (error) return { error: error.message };
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to delete action" };
  }
}
