"use server";

/**
 * Server actions for the admin Dashboard's batch/module drill-down section:
 * a weekly due-vs-completed action trend, commitment-score buckets, a
 * commitment-score leaderboard, a batch's weekly commitment-score trend
 * (+ week-over-week delta), and email open rates (welcome vs. reminder,
 * category-wise).
 *
 * Reuses getAdminContext/loadCommitmentWalletByCohort from admin-analytics.ts
 * rather than duplicating the company/role resolution or the Commitment
 * Wallet rollup math.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { chartWeekCount, resolveCohortMaxWeeks, resolveCohortWeekAnchors, sharedWeekAnchor, weekNumberFor, weekRangeFields } from "@/lib/cohort-week";
import {
  getAdminContext,
  loadCommitmentWalletByCohort,
  loadMemberEmailOpenCounts,
} from "./admin-analytics";

type Admin = ReturnType<typeof createAdminClient>;

/** The real Commitment Score, matching get_my_commitment_wallet()'s formula (see
 * supabase/migrations/073_late_completion_keeps_commitment_score.sql) and what
 * participants see on /wallet: starts at 100% when a plan is finalised and drops
 * only for outstanding misses (Pending validation / Didn't complete). Completing
 * late keeps or restores the score — NOT the points-banked/maximum-points ratio. */
function walletScorePct(plannedActions: number, missedActions: number) {
  return plannedActions > 0 ? Math.round((Math.max(0, plannedActions - missedActions) * 100) / plannedActions) : 0;
}

/** All (non-archived) cohort ids for a company, or just [cohortId] when one is selected —
 * the "consolidated / one batch" switch every action below shares. */
async function resolveCohortIds(admin: Admin, companyId: string, cohortId: string | null): Promise<string[]> {
  if (cohortId) return [cohortId];
  const { data } = await admin
    .from("cohorts")
    .select("id")
    .eq("company_id", companyId)
    .is("archived_at", null);
  return (data ?? []).map((c: { id: string }) => c.id);
}

/** End-user (role='user') ids in scope: one cohort's members, or every end-user in the company. */
async function resolveScopedUserIds(admin: Admin, companyId: string, cohortId: string | null): Promise<string[]> {
  if (cohortId) {
    const { data: memberRows } = await admin.from("cohort_members").select("user_id").eq("cohort_id", cohortId);
    const ids = [...new Set((memberRows ?? []).map((m: { user_id: string }) => m.user_id))];
    if (!ids.length) return [];
    const { data: profiles } = await admin.from("profiles").select("id, role").in("id", ids);
    return (profiles ?? [])
      .filter((p: { role: string }) => p.role === "user")
      .map((p: { id: string }) => p.id);
  }
  const { data: profiles } = await admin.from("profiles").select("id, role").eq("company_id", companyId);
  return (profiles ?? [])
    .filter((p: { role: string }) => p.role === "user")
    .map((p: { id: string }) => p.id);
}

export interface BatchOption {
  cohortId: string;
  label: string;
  /** The two halves of `label`, for the separate Batch and Module dropdowns. */
  batchName: string;
  moduleName: string | null;
}

/** Feeds the Dashboard's batch/module selector — one option per batch (labeled with its
 * module, since module_name is an attribute of the batch, not an independent filter). */
export async function getBatchOptions(companyId?: string): Promise<{ options: BatchOption[]; error?: string }> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { options: [], error: "Company required" };

    const admin = createAdminClient();
    const { data: cohorts } = await admin
      .from("cohorts")
      .select("id, batch_name, module_name")
      .eq("company_id", resolvedCompanyId)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    const options: BatchOption[] = (cohorts ?? []).map((c: { id: string; batch_name: string; module_name: string | null }) => ({
      cohortId: c.id,
      label: c.module_name ? `${c.batch_name} — ${c.module_name}` : c.batch_name,
      batchName: c.batch_name,
      moduleName: c.module_name,
    }));

    return { options };
  } catch (e) {
    return { options: [], error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface ActionWeeklyTrendEntry {
  weekNumber: number;
  /** Actions scheduled/due for delivery in this week (user_actions.scheduled_at).
   * Weeks are counted from the batch's first action delivery date. */
  due: number;
  /** Of those, how many have since been validated (status = 'success'), regardless of when. */
  completed: number;
  /** Inclusive IST dates of this week from the first delivery; null when batches differ. */
  weekStartIst: string | null;
  weekEndIst: string | null;
}

/** Weekly "due vs. completed" action counts for the batch/module drill-down: for each
 * week since the first action delivery, how many actions were scheduled to go out
 * (user_actions.scheduled_at), and how many of those have since been completed —
 * whenever the completion actually happened, not just if it landed in the same week. */
export async function getActionCompletionWeeklyTrend(
  companyId?: string,
  cohortId?: string | null
): Promise<{ entries: ActionWeeklyTrendEntry[]; error?: string }> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { entries: [], error: "Company required" };

    const admin = createAdminClient();
    const userIds = await resolveScopedUserIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!userIds.length) return { entries: [] };

    const cohortIds = await resolveCohortIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!cohortIds.length) return { entries: [] };
    const anchors = await resolveCohortWeekAnchors(admin, cohortIds);

    const { data: uaRows } = await admin
      .from("user_actions")
      .select("cohort_id, status, scheduled_at")
      .in("cohort_id", cohortIds)
      .in("user_id", userIds)
      .not("scheduled_at", "is", null);

    const weeklyMap = new Map<number, { due: number; completed: number }>();
    for (const row of (uaRows ?? []) as { cohort_id: string | null; status: string; scheduled_at: string }[]) {
      const anchor = row.cohort_id ? anchors.get(row.cohort_id) : undefined;
      if (!anchor) continue;
      const week = weekNumberFor(new Date(row.scheduled_at), anchor);
      const bucket = weeklyMap.get(week) ?? { due: 0, completed: 0 };
      bucket.due += 1;
      if (row.status === "success") bucket.completed += 1;
      weeklyMap.set(week, bucket);
    }

    const maxWeek = chartWeekCount(anchors, await resolveCohortMaxWeeks(admin, cohortIds), weeklyMap.keys());

    const displayAnchor = sharedWeekAnchor(anchors.values());
    const entries: ActionWeeklyTrendEntry[] = [];
    for (let week = 1; week <= maxWeek; week++) {
      const b = weeklyMap.get(week) ?? { due: 0, completed: 0 };
      entries.push({
        weekNumber: week,
        due: b.due,
        completed: b.completed,
        ...weekRangeFields(week, displayAnchor),
      });
    }

    return { entries };
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface CommitmentScoreBuckets {
  band90to100: number;
  band75to89: number;
  band50to74: number;
  belowBand50: number;
  /** Users with no finalised plan yet — kept separate so they don't skew "below 50" downward. */
  notStarted: number;
  totalUsers: number;
  /** Mean Commitment Score % among users with a finalised plan; null when none have activated. */
  avgCommitmentPct: number | null;
}

const EMPTY_SCORE_BUCKETS: CommitmentScoreBuckets = {
  band90to100: 0,
  band75to89: 0,
  band50to74: 0,
  belowBand50: 0,
  notStarted: 0,
  totalUsers: 0,
  avgCommitmentPct: null,
};

/** Buckets end-users by Commitment Score (same formula as /wallet: 100% minus
 * outstanding misses only): 90-100, 75-89, 50-74, below 50 — plus a "not started"
 * count for anyone without a finalised plan. */
export async function getCommitmentScoreBuckets(
  companyId?: string,
  cohortId?: string | null
): Promise<{ buckets?: CommitmentScoreBuckets; error?: string }> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { error: "Company required" };

    const admin = createAdminClient();
    const userIds = await resolveScopedUserIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!userIds.length) return { buckets: EMPTY_SCORE_BUCKETS };
    const userIdSet = new Set(userIds);

    const cohortIds = await resolveCohortIds(admin, resolvedCompanyId, cohortId ?? null);
    const commitmentByCohort = await loadCommitmentWalletByCohort(admin, cohortIds);

    const commitmentByUser = new Map<string, { maximum: number; plannedActions: number; missedActions: number }>();
    for (const { perUser } of commitmentByCohort.values()) {
      for (const [userId, uc] of perUser) {
        if (!userIdSet.has(userId)) continue;
        const existing = commitmentByUser.get(userId);
        if (existing) {
          existing.maximum += uc.maximum;
          existing.plannedActions += uc.plannedActions;
          existing.missedActions += uc.missedActions;
        } else {
          commitmentByUser.set(userId, { maximum: uc.maximum, plannedActions: uc.plannedActions, missedActions: uc.missedActions });
        }
      }
    }

    const buckets: CommitmentScoreBuckets = { ...EMPTY_SCORE_BUCKETS, totalUsers: userIds.length };
    let scoreSum = 0;
    let scoreCount = 0;
    for (const userId of userIds) {
      const c = commitmentByUser.get(userId);
      if (!c || c.maximum === 0) {
        buckets.notStarted += 1;
        continue;
      }
      const pct = walletScorePct(c.plannedActions, c.missedActions);
      scoreSum += pct;
      scoreCount += 1;
      if (pct >= 90) buckets.band90to100 += 1;
      else if (pct >= 75) buckets.band75to89 += 1;
      else if (pct >= 50) buckets.band50to74 += 1;
      else buckets.belowBand50 += 1;
    }
    buckets.avgCommitmentPct = scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null;

    return { buckets };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface DashboardLeaderboardEntry {
  id: string;
  name: string;
  email: string | null;
  /** Commitment buddy display name in scope (null when unpaired). */
  buddyName: string | null;
  commitmentPoints: number;
  commitmentMaximum: number;
  commitmentPct: number;
  plannedActions: number;
  /** user_actions delivered to the member in scope (reminders that went out). */
  actionsSentCount: number;
  /** Still-scheduled, unresolved actions — matches Actions "Current actions". */
  currentCount: number;
  validatedCount: number;
  /** Reminder or recap emails opened or clicked (Resend webhook on email_campaign_logs). */
  actionsReadCount: number;
  /** Auto-expired failures still awaiting confirm — matches Actions "Pending validation". */
  pendingValidationCount: number;
  /** Confirmed fails/skips — matches Actions "Didn't complete". */
  notCompletedCount: number;
  /** WhatsApp number on file: "active", "opted_out" (replied STOP), or null when none. */
  whatsapp: "active" | "opted_out" | null;
  /** Nudge emails an admin has sent this member from the leaderboard (successful sends). */
  nudgeCount: number;
}

/** Map user_id → buddy display name for the given cohorts (joins unique names when a
 * person has different buddies across batches in company-wide scope). */
async function loadBuddyNamesByUser(
  admin: Admin,
  cohortIds: string[],
  userIds: string[]
): Promise<Map<string, string>> {
  const buddyByUser = new Map<string, string>();
  if (!cohortIds.length || !userIds.length) return buddyByUser;

  const { data: assignments } = await admin
    .from("commitment_buddy_assignments")
    .select("user_id, buddy_user_id")
    .in("cohort_id", cohortIds)
    .in("user_id", userIds);

  const buddyIds = [
    ...new Set(
      ((assignments ?? []) as { buddy_user_id: string }[]).map((a) => a.buddy_user_id)
    ),
  ];
  if (!buddyIds.length) return buddyByUser;

  const { data: buddyProfiles } = await admin
    .from("profiles")
    .select("id, full_name")
    .in("id", buddyIds);
  const nameById = new Map(
    ((buddyProfiles ?? []) as { id: string; full_name: string | null }[]).map((p) => [
      p.id,
      p.full_name?.trim() || "User",
    ])
  );

  for (const row of (assignments ?? []) as { user_id: string; buddy_user_id: string }[]) {
    const name = nameById.get(row.buddy_user_id);
    if (!name) continue;
    const existing = buddyByUser.get(row.user_id);
    if (!existing) buddyByUser.set(row.user_id, name);
    else if (existing !== name && !existing.split(" / ").includes(name)) {
      buddyByUser.set(row.user_id, `${existing} / ${name}`);
    }
  }
  return buddyByUser;
}

/** Leaderboard ranked by commitment score % (not raw points, unlike getEngagementLeaderboard,
 * which the Engagement page keeps as-is) — scoped to one batch, or company-wide when none given. */
export async function getDashboardLeaderboard(
  companyId?: string,
  cohortId?: string | null
): Promise<{ entries: DashboardLeaderboardEntry[]; error?: string }> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { entries: [], error: "Company required" };

    const admin = createAdminClient();
    const userIds = await resolveScopedUserIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!userIds.length) return { entries: [] };
    const userIdSet = new Set(userIds);

    const { data: profiles } = await admin.from("profiles").select("id, full_name, email").in("id", userIds);
    const nameById = new Map(
      (profiles ?? []).map((p: { id: string; full_name: string | null }) => [p.id, p.full_name?.trim() || "User"])
    );
    const emailById = new Map(
      (profiles ?? []).map((p: { id: string; email: string | null }) => [p.id, p.email ?? null])
    );

    const cohortIds = await resolveCohortIds(admin, resolvedCompanyId, cohortId ?? null);
    const [commitmentByCohort, buddyByUser, emailOpensByUser, whatsappResult, nudgeResult] = await Promise.all([
      loadCommitmentWalletByCohort(admin, cohortIds),
      loadBuddyNamesByUser(admin, cohortIds, userIds),
      loadMemberEmailOpenCounts(admin, userIds, cohortIds),
      admin.from("whatsapp_contacts").select("user_id, phone, opted_out_at").in("user_id", userIds),
      // Admin nudges (app/actions/admin-nudge.ts), counted per person across batches.
      admin
        .from("email_campaign_logs")
        .select("user_id")
        .eq("template_id", "admin_nudge")
        .eq("status", "sent")
        .in("user_id", userIds),
    ]);
    const nudgeCountByUser = new Map<string, number>();
    for (const row of (nudgeResult.data ?? []) as { user_id: string }[]) {
      nudgeCountByUser.set(row.user_id, (nudgeCountByUser.get(row.user_id) ?? 0) + 1);
    }
    const whatsappByUser = new Map<string, "active" | "opted_out">();
    for (const contact of (whatsappResult.data ?? []) as { user_id: string; phone: string | null; opted_out_at: string | null }[]) {
      if (contact.phone?.trim()) whatsappByUser.set(contact.user_id, contact.opted_out_at ? "opted_out" : "active");
    }

    const commitmentByUser = new Map<string, { points: number; maximum: number; plannedActions: number; missedActions: number }>();
    for (const { perUser } of commitmentByCohort.values()) {
      for (const [userId, uc] of perUser) {
        if (!userIdSet.has(userId)) continue;
        const existing = commitmentByUser.get(userId);
        if (existing) {
          existing.points += uc.points;
          existing.maximum += uc.maximum;
          existing.plannedActions += uc.plannedActions;
          existing.missedActions += uc.missedActions;
        } else {
          commitmentByUser.set(userId, { points: uc.points, maximum: uc.maximum, plannedActions: uc.plannedActions, missedActions: uc.missedActions });
        }
      }
    }

    // Same Action reader / Pending validation / Didn't complete split as cohort analytics members.
    let uaQuery = admin
      .from("user_actions")
      .select("user_id, status, auto_expired")
      .in("user_id", userIds);
    if (cohortId) uaQuery = uaQuery.eq("cohort_id", cohortId);
    else if (cohortIds.length) uaQuery = uaQuery.in("cohort_id", cohortIds);
    const { data: uaRows } = await uaQuery;

    const actionsSentByUser = new Map<string, number>();
    const currentByUser = new Map<string, number>();
    const validatedByUser = new Map<string, number>();
    const pendingByUser = new Map<string, number>();
    const notCompletedByUser = new Map<string, number>();
    for (const row of (uaRows ?? []) as {
      user_id: string;
      status: string;
      auto_expired: boolean | null;
    }[]) {
      actionsSentByUser.set(row.user_id, (actionsSentByUser.get(row.user_id) ?? 0) + 1);
      if (row.status === "scheduled") {
        currentByUser.set(row.user_id, (currentByUser.get(row.user_id) ?? 0) + 1);
      }
      if (row.status === "success") {
        validatedByUser.set(row.user_id, (validatedByUser.get(row.user_id) ?? 0) + 1);
      }
      if (row.status === "failed" && row.auto_expired) {
        pendingByUser.set(row.user_id, (pendingByUser.get(row.user_id) ?? 0) + 1);
      } else if ((row.status === "failed" || row.status === "skipped") && !row.auto_expired) {
        notCompletedByUser.set(row.user_id, (notCompletedByUser.get(row.user_id) ?? 0) + 1);
      }
    }

    const entries: DashboardLeaderboardEntry[] = userIds.map((id) => {
      const c = commitmentByUser.get(id);
      return {
        id,
        name: nameById.get(id) ?? "User",
        email: emailById.get(id) ?? null,
        buddyName: buddyByUser.get(id) ?? null,
        commitmentPoints: c?.points ?? 0,
        commitmentMaximum: c?.maximum ?? 0,
        commitmentPct: walletScorePct(c?.plannedActions ?? 0, c?.missedActions ?? 0),
        plannedActions: c?.plannedActions ?? 0,
        actionsSentCount: actionsSentByUser.get(id) ?? 0,
        currentCount: currentByUser.get(id) ?? 0,
        validatedCount: validatedByUser.get(id) ?? 0,
        actionsReadCount: emailOpensByUser.get(id)?.eitherOpened ?? 0,
        pendingValidationCount: pendingByUser.get(id) ?? 0,
        notCompletedCount: notCompletedByUser.get(id) ?? 0,
        whatsapp: whatsappByUser.get(id) ?? null,
        nudgeCount: nudgeCountByUser.get(id) ?? 0,
      };
    });
    entries.sort((a, b) => b.commitmentPct - a.commitmentPct || b.commitmentPoints - a.commitmentPoints);

    return { entries };
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface ProgramProgress {
  /** Current programme week (1-indexed), capped at the programme length. */
  currentWeek: number;
  /** Programme length in weeks (cohorts.max_weeks); null when not set. */
  maxWeeks: number | null;
  /** True once the programme length has been fully used up. */
  ended: boolean;
}

/** Where the batch is in its programme, on the same week clock as the dashboard
 * charts. Across several batches it reports the furthest-along one. */
export async function getProgramProgress(
  companyId?: string | null,
  cohortId?: string | null
): Promise<{ progress: ProgramProgress | null; error?: string }> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { progress: null, error: "Company required" };

    const admin = createAdminClient();
    const cohortIds = await resolveCohortIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!cohortIds.length) return { progress: null };

    const [anchors, maxWeeksByCohort] = await Promise.all([
      resolveCohortWeekAnchors(admin, cohortIds),
      resolveCohortMaxWeeks(admin, cohortIds),
    ]);
    if (!anchors.size) return { progress: null };

    const now = new Date();
    let best: ProgramProgress | null = null;
    for (const [id, anchor] of anchors) {
      const elapsed = weekNumberFor(now, anchor);
      const maxWeeks = maxWeeksByCohort.get(id) ?? null;
      const candidate: ProgramProgress = {
        currentWeek: maxWeeks ? Math.min(elapsed, maxWeeks) : elapsed,
        maxWeeks,
        ended: maxWeeks !== null && elapsed > maxWeeks,
      };
      if (!best || candidate.currentWeek > best.currentWeek) best = candidate;
    }
    return { progress: best };
  } catch (e) {
    return { progress: null, error: e instanceof Error ? e.message : "Failed" };
  }
}

export type ParticipantActionStatus =
  | "completed"
  | "current"
  | "pending_validation"
  | "not_completed"
  | "not_sent";

export interface ParticipantActionRow {
  id: string;
  title: string;
  status: ParticipantActionStatus;
  /** When the plan holding this action was finalised; null for actions outside a wallet plan. */
  plannedAt: string | null;
  /** When the action was delivered; null until it goes out. */
  sentAt: string | null;
  completedAt: string | null;
  completedVia: "app" | "whatsapp" | null;
  /** First time the participant opened a reminder email / read a WhatsApp reminder
   * sent while this action was live; null if not seen (or no read receipt). */
  seenAt: string | null;
  seenVia: "email" | "whatsapp" | null;
  /** True when seenAt comes from an older reminder that didn't record its actions,
   * matched by send time instead of by the action itself. */
  seenEstimated: boolean;
}

/** Reads reminder log rows with their action_ids, retrying without that column if
 * migration 087 hasn't been applied yet, so the popup still loads (timing match only). */
async function loadSeenReminderRows(
  admin: ReturnType<typeof createAdminClient>,
  table: "email_campaign_logs" | "whatsapp_message_logs",
  columns: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: (query: any) => any
): Promise<Record<string, unknown>[]> {
  const extra = table === "email_campaign_logs" ? ", template_id" : "";
  const withIds = await filter(admin.from(table).select(`${columns}${extra}, action_ids`));
  if (!withIds.error) return (withIds.data ?? []) as Record<string, unknown>[];
  const withoutIds = await filter(admin.from(table).select(`${columns}${extra}`));
  return (withoutIds.data ?? []) as Record<string, unknown>[];
}

/** Reminders don't record which actions they listed, so a reminder counts towards an
 * action if it went out while that action was live: from delivery until completion,
 * or for this long after delivery when it was never completed. */
const SEEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Same Current / Pending validation / Didn't complete split as the leaderboard's counts. */
function participantActionStatus(
  ua: { status: string; auto_expired: boolean | null } | undefined
): ParticipantActionStatus {
  if (!ua) return "not_sent";
  if (ua.status === "success") return "completed";
  if (ua.status === "scheduled") return "current";
  return ua.status === "failed" && ua.auto_expired ? "pending_validation" : "not_completed";
}

/** Every action a participant planned in scope, with when it was planned, sent and completed.
 * Actions sent outside a wallet plan are included too, so the list matches "Actions sent". */
export async function getParticipantActionTimeline(
  userId: string,
  companyId?: string | null,
  cohortId?: string | null
): Promise<{ rows: ParticipantActionRow[]; whatsappPhone?: string | null; error?: string }> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { rows: [], error: "Company required" };

    const admin = createAdminClient();

    // The caller supplies these ids, so confirm the batch and participant are in
    // this company before reading anything: the admin client bypasses RLS.
    if (cohortId) {
      const { data: cohort } = await admin
        .from("cohorts")
        .select("id")
        .eq("id", cohortId)
        .eq("company_id", resolvedCompanyId)
        .maybeSingle();
      if (!cohort) return { rows: [], error: "Batch not found" };
    }
    const scopedUserIds = await resolveScopedUserIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!scopedUserIds.includes(userId)) return { rows: [], error: "Participant not found" };

    // WhatsApp number on file (for the popup footer); null when none saved.
    const { data: contact } = await admin
      .from("whatsapp_contacts")
      .select("phone")
      .eq("user_id", userId)
      .maybeSingle();
    const whatsappPhone = (contact as { phone: string | null } | null)?.phone?.trim() || null;

    const cohortIds = await resolveCohortIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!cohortIds.length) return { rows: [], whatsappPhone };

    const [plansResult, walletActionsResult, userActionsResult, emailRows, whatsappRows] = await Promise.all([
      admin.from("commitment_wallet_plans").select("id, finalised_at").eq("user_id", userId).in("cohort_id", cohortIds),
      admin.from("commitment_wallet_actions").select("action_id, plan_id").eq("user_id", userId).in("cohort_id", cohortIds),
      admin
        .from("user_actions")
        .select("action_id, status, auto_expired, scheduled_at, created_at, completed_at, completed_via")
        .eq("user_id", userId)
        .in("cohort_id", cohortIds),
      loadSeenReminderRows(admin, "email_campaign_logs", "cohort_id, created_at, opened_at, clicked_at", (q) =>
        q.eq("user_id", userId).in("template_id", ["daily_reminder", "weekly_recap"]).eq("status", "sent")
      ),
      loadSeenReminderRows(admin, "whatsapp_message_logs", "created_at, read_at", (q) =>
        q.eq("user_id", userId).in("purpose", ["action_reminder", "action_reminder_manual"]).not("read_at", "is", null)
      ),
    ]);
    const queryError = plansResult.error ?? walletActionsResult.error ?? userActionsResult.error;
    if (queryError) return { rows: [], whatsappPhone, error: queryError.message };

    // Every reminder this participant actually saw: when it went out, when it was
    // first opened/read, and (for reminders sent since migration 087) which actions it listed.
    type SeenReminder = { sentMs: number; seenAt: string; via: "email" | "whatsapp"; actionIds: string[] | null; recap: boolean };
    const cohortIdSet = new Set(cohortIds);
    const seenReminders: SeenReminder[] = [];
    for (const row of emailRows as {
      cohort_id: string | null;
      template_id?: string;
      created_at: string;
      opened_at: string | null;
      clicked_at: string | null;
      action_ids?: string[] | null;
    }[]) {
      if (row.cohort_id && !cohortIdSet.has(row.cohort_id)) continue;
      // A click implies an open (some clients block the open pixel).
      const seenAt = row.opened_at ?? row.clicked_at;
      if (!seenAt) continue;
      seenReminders.push({
        sentMs: Date.parse(row.created_at),
        seenAt,
        via: "email",
        actionIds: row.action_ids ?? null,
        recap: row.template_id === "weekly_recap",
      });
    }
    for (const row of whatsappRows as { created_at: string; read_at: string; action_ids?: string[] | null }[]) {
      seenReminders.push({
        sentMs: Date.parse(row.created_at),
        seenAt: row.read_at,
        via: "whatsapp",
        actionIds: row.action_ids ?? null,
        recap: false,
      });
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const firstSeen = (actionId: string, fromIso: string | null, untilIso: string | null) => {
      let exact: SeenReminder | null = null;
      let estimated: SeenReminder | null = null;
      // Fallback window for older reminders: from IST midnight on the delivery day
      // (the reminder's fixed send time can fall just before the stored delivery
      // timestamp) until completion, or SEEN_WINDOW_MS after delivery.
      const fromMs = fromIso ? Math.floor((Date.parse(fromIso) + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS : null;
      const untilMs = fromIso ? (untilIso ? Date.parse(untilIso) : Date.parse(fromIso) + SEEN_WINDOW_MS) : null;
      const earlier = (a: SeenReminder | null, b: SeenReminder) => (!a || Date.parse(b.seenAt) < Date.parse(a.seenAt) ? b : a);
      for (const r of seenReminders) {
        if (r.actionIds) {
          if (r.actionIds.includes(actionId)) exact = earlier(exact, r);
        } else if (!r.recap && fromMs !== null && untilMs !== null && r.sentMs >= fromMs && r.sentMs <= untilMs) {
          estimated = earlier(estimated, r);
        }
      }
      const best = exact ?? estimated;
      return best ? { seenAt: best.seenAt, via: best.via, estimated: !exact } : null;
    };

    const finalisedAtByPlan = new Map(
      ((plansResult.data ?? []) as { id: string; finalised_at: string }[]).map((plan) => [plan.id, plan.finalised_at])
    );
    const plannedAtByAction = new Map(
      ((walletActionsResult.data ?? []) as { action_id: string; plan_id: string }[]).map((row) => [
        row.action_id,
        finalisedAtByPlan.get(row.plan_id) ?? null,
      ])
    );
    const userActionByAction = new Map(
      (
        (userActionsResult.data ?? []) as {
          action_id: string;
          status: string;
          auto_expired: boolean | null;
          scheduled_at: string | null;
          created_at: string;
          completed_at: string | null;
          completed_via: "app" | "whatsapp" | null;
        }[]
      ).map((row) => [row.action_id, row])
    );

    const actionIds = [...new Set([...plannedAtByAction.keys(), ...userActionByAction.keys()])];
    if (!actionIds.length) return { rows: [], whatsappPhone };

    const { data: actions, error: actionsError } = await admin
      .from("actions")
      .select("id, title, plan_order, created_at")
      .in("id", actionIds)
      .order("plan_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    if (actionsError) return { rows: [], whatsappPhone, error: actionsError.message };

    const rows = ((actions ?? []) as { id: string; title: string }[]).map((action) => {
      const ua = userActionByAction.get(action.id);
      const sentAt = ua ? ua.scheduled_at ?? ua.created_at : null;
      const seen = firstSeen(action.id, sentAt, ua?.status === "success" ? ua.completed_at : null);
      return {
        id: action.id,
        title: action.title,
        status: participantActionStatus(ua),
        plannedAt: plannedAtByAction.get(action.id) ?? null,
        sentAt,
        completedAt: ua?.status === "success" ? ua.completed_at : null,
        completedVia: ua?.status === "success" ? ua.completed_via : null,
        seenAt: seen?.seenAt ?? null,
        seenVia: seen?.via ?? null,
        seenEstimated: seen?.estimated ?? false,
      };
    });
    return { rows, whatsappPhone };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : "Failed to load actions" };
  }
}

export interface CommitmentWeeklyTrendEntry {
  weekNumber: number;
  avgCommitmentPct: number;
  weekStartIst: string | null;
  weekEndIst: string | null;
}

/** Average commitment score per week since the first action delivery (cumulative, as of the end of each week),
 * plus a ready-made week-over-week delta for the last two elapsed weeks. */
export async function getBatchCommitmentWeeklyTrend(
  companyId?: string,
  cohortId?: string | null
): Promise<{
  entries: CommitmentWeeklyTrendEntry[];
  currentWeekAvg: number | null;
  previousWeekAvg: number | null;
  deltaPct: number | null;
  error?: string;
}> {
  const empty = { entries: [], currentWeekAvg: null, previousWeekAvg: null, deltaPct: null };
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { ...empty, error: "Company required" };

    const admin = createAdminClient();
    const cohortIds = await resolveCohortIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!cohortIds.length) return empty;

    const anchors = await resolveCohortWeekAnchors(admin, cohortIds);

    const { data: plans } = await admin
      .from("commitment_wallet_plans")
      .select("id, cohort_id, planned_actions, finalised_at")
      .in("cohort_id", cohortIds);
    const planRows = (plans ?? []) as {
      id: string;
      cohort_id: string;
      planned_actions: number;
      finalised_at: string;
    }[];
    if (!planRows.length) return empty;
    const planIds = planRows.map((p) => p.id);

    const { data: events } = await admin
      .from("commitment_wallet_events")
      .select("plan_id, event_type, settled_at")
      .in("plan_id", planIds)
      .order("settled_at", { ascending: true });
    const eventsByPlan = new Map<string, { missed: boolean; settledAt: string }[]>();
    for (const e of (events ?? []) as { plan_id: string; event_type: string; settled_at: string }[]) {
      const list = eventsByPlan.get(e.plan_id) ?? [];
      list.push({ missed: e.event_type === "missed", settledAt: e.settled_at });
      eventsByPlan.set(e.plan_id, list);
    }

    // Only misses move the score, so a later non-miss event doesn't extend the axis.
    const scoreWeeks: number[] = [];
    for (const plan of planRows) {
      const anchor = anchors.get(plan.cohort_id);
      if (!anchor) continue;
      scoreWeeks.push(weekNumberFor(new Date(plan.finalised_at), anchor));
      for (const e of eventsByPlan.get(plan.id) ?? []) {
        if (e.missed) scoreWeeks.push(weekNumberFor(new Date(e.settledAt), anchor));
      }
    }
    const maxWeek = chartWeekCount(anchors, await resolveCohortMaxWeeks(admin, cohortIds), scoreWeeks);

    // Same formula as get_my_commitment_wallet() / the /wallet page (see walletScorePct) —
    // outstanding misses only, tracked cumulatively per week.
    const weeklySums = new Map<number, { sum: number; count: number }>();
    for (const plan of planRows) {
      const anchor = anchors.get(plan.cohort_id);
      if (!anchor) continue;
      const plannedActions = plan.planned_actions;
      if (plannedActions <= 0) continue;

      const finalisedWeek = weekNumberFor(new Date(plan.finalised_at), anchor);
      const events = (eventsByPlan.get(plan.id) ?? []).map((e) => ({
        missed: e.missed,
        week: weekNumberFor(new Date(e.settledAt), anchor),
      }));

      let cumMissed = 0;
      let eventIdx = 0;
      for (let week = 1; week <= maxWeek; week++) {
        while (eventIdx < events.length && events[eventIdx].week <= week) {
          if (events[eventIdx].missed) cumMissed += 1;
          eventIdx += 1;
        }
        if (week < finalisedWeek) continue; // plan didn't exist yet at this point in the batch

        const pct = walletScorePct(plannedActions, cumMissed);
        const entry = weeklySums.get(week) ?? { sum: 0, count: 0 };
        entry.sum += pct;
        entry.count += 1;
        weeklySums.set(week, entry);
      }
    }

    const displayAnchor = sharedWeekAnchor(anchors.values());
    const entries: CommitmentWeeklyTrendEntry[] = [];
    for (let week = 1; week <= maxWeek; week++) {
      const s = weeklySums.get(week);
      entries.push({
        weekNumber: week,
        avgCommitmentPct: s && s.count > 0 ? Math.round(s.sum / s.count) : 0,
        ...weekRangeFields(week, displayAnchor),
      });
    }

    const currentWeekAvg = entries.length ? entries[entries.length - 1].avgCommitmentPct : null;
    const previousWeekAvg = entries.length > 1 ? entries[entries.length - 2].avgCommitmentPct : null;
    const deltaPct = currentWeekAvg !== null && previousWeekAvg !== null ? currentWeekAvg - previousWeekAvg : null;

    return { entries, currentWeekAvg, previousWeekAvg, deltaPct };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface EmailOpenWeeklyEntry {
  weekNumber: number;
  welcomeSent: number;
  welcomeOpened: number;
  welcomeOpenRate: number;
  welcomeClicked: number;
  welcomeClickRate: number;
  reminderSent: number;
  reminderOpened: number;
  reminderOpenRate: number;
  reminderClicked: number;
  reminderClickRate: number;
  recapSent: number;
  recapOpened: number;
  recapOpenRate: number;
  recapClicked: number;
  recapClickRate: number;
  /** Unique users who received at least one reminder that week. */
  reminderUsers: number;
  /** Unique users who received at least one Friday recap that week. */
  recapUsers: number;
  /** Unique users who received reminder and/or recap that week (union). */
  eitherMailUsers: number;
  /** Unique users who opened at least one reminder that week. */
  reminderOpenedUsers: number;
  /** Unique users who opened at least one Friday recap that week. */
  recapOpenedUsers: number;
  /** Unique users who opened reminder and/or recap that week (union). */
  eitherMailOpenedUsers: number;
  /** Reminder + Friday recap emails sent / opened that week (message-level). */
  emailSent: number;
  emailOpened: number;
  emailOpenRate: number;
  /** WhatsApp action reminders sent (not failed) / read that week (message-level). */
  whatsappSent: number;
  whatsappRead: number;
  whatsappReadRate: number;
  /** Validated actions that were sent that week (by scheduled_at), split by where they were marked done. */
  completedViaWhatsapp: number;
  completedViaApp: number;
  weekStartIst: string | null;
  weekEndIst: string | null;
}

export interface EmailEngagementTotals {
  sent: number;
  opened: number;
  openRate: number;
  clicked: number;
  clickRate: number;
  /** Unique users who opened at least one email in this category. */
  openedUsers: number;
}

const ZERO_TOTALS: EmailEngagementTotals = {
  sent: 0,
  opened: 0,
  openRate: 0,
  clicked: 0,
  clickRate: 0,
  openedUsers: 0,
};

/** Weekly + total-current open AND click rates for welcome ("credentials"),
 * reminder ("daily_reminder"), and Friday weekly recap ("weekly_recap") emails,
 * category-wise, from Resend via the webhook at app/api/webhooks/resend/route.ts.
 * `webhookConfigured` tells the UI whether to show a "tracking not enabled yet"
 * banner instead of trusting a flat 0% as real data. */
export async function getEmailOpenRates(
  companyId?: string,
  cohortId?: string | null
): Promise<{
  weekly: EmailOpenWeeklyEntry[];
  welcomeTotals: EmailEngagementTotals;
  reminderTotals: EmailEngagementTotals;
  recapTotals: EmailEngagementTotals;
  eitherTotals: EmailEngagementTotals;
  webhookConfigured: boolean;
  error?: string;
}> {
  const empty = {
    weekly: [],
    welcomeTotals: ZERO_TOTALS,
    reminderTotals: ZERO_TOTALS,
    recapTotals: ZERO_TOTALS,
    eitherTotals: ZERO_TOTALS,
    webhookConfigured: !!process.env.RESEND_WEBHOOK_SECRET,
  };
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) return { ...empty, error: "Company required" };

    const admin = createAdminClient();
    const cohortIds = await resolveCohortIds(admin, resolvedCompanyId, cohortId ?? null);
    if (!cohortIds.length) return empty;

    const anchors = await resolveCohortWeekAnchors(admin, cohortIds);
    const scopedUserIds = await resolveScopedUserIds(admin, resolvedCompanyId, cohortId ?? null);
    const cohortIdSet = new Set(cohortIds);
    const scopedUserSet = new Set(scopedUserIds);
    const emailTemplates = ["credentials", "daily_reminder", "weekly_recap"] as const;

    const { data: attributedRows } = await admin
      .from("email_campaign_logs")
      .select("user_id, template_id, cohort_id, created_at, opened_at, clicked_at")
      .in("cohort_id", cohortIds)
      .in("template_id", [...emailTemplates])
      .eq("status", "sent");

    // Older sends logged cohort_id as null, so also pull those rows by recipient
    // membership in the selected batch(es).
    const { data: unattributedRows } = scopedUserIds.length
      ? await admin
          .from("email_campaign_logs")
          .select("user_id, template_id, cohort_id, created_at, opened_at, clicked_at")
          .is("cohort_id", null)
          .in("user_id", scopedUserIds)
          .in("template_id", [...emailTemplates])
          .eq("status", "sent")
      : { data: [] };

    const seen = new Set<string>();
    const emailRows: {
      user_id: string | null;
      template_id: string;
      cohort_id: string | null;
      created_at: string;
      opened_at: string | null;
      clicked_at: string | null;
    }[] = [];
    for (const row of [...(attributedRows ?? []), ...(unattributedRows ?? [])] as typeof emailRows) {
      const key = `${row.user_id ?? ""}|${row.template_id}|${row.created_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.cohort_id) {
        if (!cohortIdSet.has(row.cohort_id)) continue;
      } else if (!row.user_id || !scopedUserSet.has(row.user_id)) {
        continue;
      }
      emailRows.push(row);
    }

    const profileCohortByUser = new Map<string, string>();
    if (scopedUserIds.length) {
      const { data: profileRows } = await admin
        .from("profiles")
        .select("id, selected_cohort_id, current_cohort_id")
        .in("id", scopedUserIds);
      for (const p of (profileRows ?? []) as {
        id: string;
        selected_cohort_id: string | null;
        current_cohort_id: string | null;
      }[]) {
        const inferred = p.selected_cohort_id ?? p.current_cohort_id;
        if (inferred && cohortIdSet.has(inferred)) profileCohortByUser.set(p.id, inferred);
      }
    }

    type WeekBucket = {
      welcomeSent: number;
      welcomeOpened: number;
      welcomeClicked: number;
      reminderSent: number;
      reminderOpened: number;
      reminderClicked: number;
      recapSent: number;
      recapOpened: number;
      recapClicked: number;
      reminderUserIds: Set<string>;
      recapUserIds: Set<string>;
      reminderOpenedUserIds: Set<string>;
      recapOpenedUserIds: Set<string>;
    };

    let welcomeSentTotal = 0;
    let welcomeOpenedTotal = 0;
    let welcomeClickedTotal = 0;
    let reminderSentTotal = 0;
    let reminderOpenedTotal = 0;
    let reminderClickedTotal = 0;
    let recapSentTotal = 0;
    let recapOpenedTotal = 0;
    let recapClickedTotal = 0;
    const welcomeOpenedUserIds = new Set<string>();
    const reminderOpenedUserIds = new Set<string>();
    const recapOpenedUserIds = new Set<string>();
    const weeklyMap = new Map<number, WeekBucket>();
    const emptyWeek = (): WeekBucket => ({
      welcomeSent: 0,
      welcomeOpened: 0,
      welcomeClicked: 0,
      reminderSent: 0,
      reminderOpened: 0,
      reminderClicked: 0,
      recapSent: 0,
      recapOpened: 0,
      recapClicked: 0,
      reminderUserIds: new Set(),
      recapUserIds: new Set(),
      reminderOpenedUserIds: new Set(),
      recapOpenedUserIds: new Set(),
    });

    for (const row of emailRows) {
      // Click implies open (clients that block pixels often only fire click events).
      const clicked = !!row.clicked_at;
      const opened = !!row.opened_at || clicked;

      const attributedCohortId =
        row.cohort_id
        ?? (cohortId && cohortIdSet.has(cohortId) ? cohortId : null)
        ?? (row.user_id ? profileCohortByUser.get(row.user_id) ?? null : null);
      const anchor = attributedCohortId ? anchors.get(attributedCohortId) : undefined;
      // Cards + weekly chart share this attribution gate so overall % matches the bars
      // (legacy rows with no batch week would otherwise dilute the card to ~0%).
      if (!anchor) continue;

      const week = weekNumberFor(new Date(row.created_at), anchor);
      const bucket = weeklyMap.get(week) ?? emptyWeek();
      if (row.template_id === "credentials") {
        welcomeSentTotal += 1;
        bucket.welcomeSent += 1;
        if (opened) {
          welcomeOpenedTotal += 1;
          bucket.welcomeOpened += 1;
          if (row.user_id) welcomeOpenedUserIds.add(row.user_id);
        }
        if (clicked) {
          welcomeClickedTotal += 1;
          bucket.welcomeClicked += 1;
        }
      } else if (row.template_id === "daily_reminder") {
        reminderSentTotal += 1;
        bucket.reminderSent += 1;
        if (row.user_id) bucket.reminderUserIds.add(row.user_id);
        if (opened) {
          reminderOpenedTotal += 1;
          bucket.reminderOpened += 1;
          if (row.user_id) {
            bucket.reminderOpenedUserIds.add(row.user_id);
            reminderOpenedUserIds.add(row.user_id);
          }
        }
        if (clicked) {
          reminderClickedTotal += 1;
          bucket.reminderClicked += 1;
        }
      } else if (row.template_id === "weekly_recap") {
        recapSentTotal += 1;
        bucket.recapSent += 1;
        if (row.user_id) bucket.recapUserIds.add(row.user_id);
        if (opened) {
          recapOpenedTotal += 1;
          bucket.recapOpened += 1;
          if (row.user_id) {
            bucket.recapOpenedUserIds.add(row.user_id);
            recapOpenedUserIds.add(row.user_id);
          }
        }
        if (clicked) {
          recapClickedTotal += 1;
          bucket.recapClicked += 1;
        }
      }
      weeklyMap.set(week, bucket);
    }

    // WhatsApp action reminders, bucketed into the same batch weeks. These logs carry
    // no cohort, so attribute them like the legacy email rows: selected batch, else
    // the recipient's profile batch.
    const whatsappWeekMap = new Map<number, { sent: number; read: number }>();
    if (scopedUserIds.length) {
      const { data: waRows } = await admin
        .from("whatsapp_message_logs")
        .select("user_id, status, created_at, read_at")
        .in("user_id", scopedUserIds)
        .in("purpose", ["action_reminder", "action_reminder_manual"]);
      for (const row of (waRows ?? []) as {
        user_id: string;
        status: string;
        created_at: string;
        read_at: string | null;
      }[]) {
        if (row.status === "failed") continue;
        const attributedCohortId =
          (cohortId && cohortIdSet.has(cohortId) ? cohortId : null) ?? profileCohortByUser.get(row.user_id) ?? null;
        const anchor = attributedCohortId ? anchors.get(attributedCohortId) : undefined;
        if (!anchor) continue;
        const week = weekNumberFor(new Date(row.created_at), anchor);
        const bucket = whatsappWeekMap.get(week) ?? { sent: 0, read: 0 };
        bucket.sent += 1;
        if (row.read_at || row.status === "read") bucket.read += 1;
        whatsappWeekMap.set(week, bucket);
      }
    }

    // Validated actions by the week they were SENT (scheduled_at, else created_at —
    // the same "sent on" as the participant popup) and where they were marked done
    // (app vs WhatsApp reply). Bucketing by send week keeps each row about the same
    // reminders as its email open / WhatsApp read rates.
    const completionWeekMap = new Map<number, { whatsapp: number; app: number }>();
    const { data: completedRows } = await admin
      .from("user_actions")
      .select("cohort_id, scheduled_at, created_at, completed_via")
      .in("cohort_id", cohortIds)
      .eq("status", "success");
    for (const row of (completedRows ?? []) as {
      cohort_id: string;
      scheduled_at: string | null;
      created_at: string;
      completed_via: "app" | "whatsapp" | null;
    }[]) {
      const anchor = anchors.get(row.cohort_id);
      if (!anchor) continue;
      const week = weekNumberFor(new Date(row.scheduled_at ?? row.created_at), anchor);
      const bucket = completionWeekMap.get(week) ?? { whatsapp: 0, app: 0 };
      if (row.completed_via === "whatsapp") bucket.whatsapp += 1;
      else bucket.app += 1;
      completionWeekMap.set(week, bucket);
    }

    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
    const unionSize =(a: Set<string>, b: Set<string>) => {
      const either = new Set(a);
      for (const id of b) either.add(id);
      return either.size;
    };

    const displayAnchor = sharedWeekAnchor(anchors.values());
    // Same axis as the other dashboard charts, so a new week is visible even
    // before any reminder has gone out that week.
    const maxWeek = chartWeekCount(
      anchors,
      await resolveCohortMaxWeeks(admin, cohortIds),
      [...weeklyMap.keys(), ...whatsappWeekMap.keys(), ...completionWeekMap.keys()]
    );
    const weekly: EmailOpenWeeklyEntry[] = weeklyMap.size || whatsappWeekMap.size || completionWeekMap.size
      ? Array.from({ length: maxWeek }, (_, i) => {
          const week = i + 1;
          const b = weeklyMap.get(week) ?? emptyWeek();
          const wa = whatsappWeekMap.get(week) ?? { sent: 0, read: 0 };
          const done = completionWeekMap.get(week) ?? { whatsapp: 0, app: 0 };
          const emailSent = b.reminderSent + b.recapSent;
          const emailOpened = b.reminderOpened + b.recapOpened;
          return {
            weekNumber: week,
            welcomeSent: b.welcomeSent,
            welcomeOpened: b.welcomeOpened,
            welcomeOpenRate: pct(b.welcomeOpened, b.welcomeSent),
            welcomeClicked: b.welcomeClicked,
            welcomeClickRate: pct(b.welcomeClicked, b.welcomeSent),
            reminderSent: b.reminderSent,
            reminderOpened: b.reminderOpened,
            reminderOpenRate: pct(b.reminderOpened, b.reminderSent),
            reminderClicked: b.reminderClicked,
            reminderClickRate: pct(b.reminderClicked, b.reminderSent),
            recapSent: b.recapSent,
            recapOpened: b.recapOpened,
            recapOpenRate: pct(b.recapOpened, b.recapSent),
            recapClicked: b.recapClicked,
            recapClickRate: pct(b.recapClicked, b.recapSent),
            reminderUsers: b.reminderUserIds.size,
            recapUsers: b.recapUserIds.size,
            eitherMailUsers: unionSize(b.reminderUserIds, b.recapUserIds),
            reminderOpenedUsers: b.reminderOpenedUserIds.size,
            recapOpenedUsers: b.recapOpenedUserIds.size,
            eitherMailOpenedUsers: unionSize(b.reminderOpenedUserIds, b.recapOpenedUserIds),
            emailSent,
            emailOpened,
            emailOpenRate: pct(emailOpened, emailSent),
            whatsappSent: wa.sent,
            whatsappRead: wa.read,
            whatsappReadRate: pct(wa.read, wa.sent),
            completedViaWhatsapp: done.whatsapp,
            completedViaApp: done.app,
            ...weekRangeFields(week, displayAnchor),
          };
        })
      : [];

    const eitherOpenedUserIds = new Set(reminderOpenedUserIds);
    for (const id of recapOpenedUserIds) eitherOpenedUserIds.add(id);
    const eitherSentTotal = reminderSentTotal + recapSentTotal;
    const eitherOpenedTotal = reminderOpenedTotal + recapOpenedTotal;
    const eitherClickedTotal = reminderClickedTotal + recapClickedTotal;

    return {
      weekly,
      welcomeTotals: {
        sent: welcomeSentTotal,
        opened: welcomeOpenedTotal,
        openRate: pct(welcomeOpenedTotal, welcomeSentTotal),
        clicked: welcomeClickedTotal,
        clickRate: pct(welcomeClickedTotal, welcomeSentTotal),
        openedUsers: welcomeOpenedUserIds.size,
      },
      reminderTotals: {
        sent: reminderSentTotal,
        opened: reminderOpenedTotal,
        openRate: pct(reminderOpenedTotal, reminderSentTotal),
        clicked: reminderClickedTotal,
        clickRate: pct(reminderClickedTotal, reminderSentTotal),
        openedUsers: reminderOpenedUserIds.size,
      },
      recapTotals: {
        sent: recapSentTotal,
        opened: recapOpenedTotal,
        openRate: pct(recapOpenedTotal, recapSentTotal),
        clicked: recapClickedTotal,
        clickRate: pct(recapClickedTotal, recapSentTotal),
        openedUsers: recapOpenedUserIds.size,
      },
      eitherTotals: {
        sent: eitherSentTotal,
        opened: eitherOpenedTotal,
        openRate: pct(eitherOpenedTotal, eitherSentTotal),
        clicked: eitherClickedTotal,
        clickRate: pct(eitherClickedTotal, eitherSentTotal),
        openedUsers: eitherOpenedUserIds.size,
      },
      webhookConfigured: !!process.env.RESEND_WEBHOOK_SECRET,
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "Failed" };
  }
}
