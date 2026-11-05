"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { chartWeekCount, resolveCohortMaxWeeks, resolveCohortWeekAnchors, sharedWeekAnchor, weekAnchorFromTimestamp, weekNumberFor, weekRangeFields } from "@/lib/cohort-week";

/** Exported so app/actions/admin-dashboard.ts can reuse the same role/company
 * resolution instead of duplicating it — "use server" files may only export
 * async functions (plus types), which this already is. */
export async function getAdminContext(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  companyId: string | null;
  role: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, company_id")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "user";
  if (role !== "admin" && role !== "superadmin") {
    throw new Error("Forbidden: admin or superadmin only");
  }

  return {
    supabase,
    companyId: profile?.company_id ?? null,
    role,
  };
}

export interface UserCommitment {
  points: number;
  maximum: number;
  plannedActions: number;
  missedActions: number;
  completedOnTimeActions: number;
}

interface CohortCommitment {
  team: {
    points: number;
    maximum: number;
    planPoints: number;
    actionPoints: number;
    memberCount: number;
    plannedActions: number;
    missedActions: number;
  };
  perUser: Map<string, UserCommitment>;
}

/** Loads Commitment Wallet totals (the real points system — see app/actions/commitment-wallet.ts
 * and 045/046_commitment_wallet.sql) for a set of cohorts, grouped per cohort and per user within
 * it. Mirrors the math in the get_my_commitment_wallet() SQL function: a finalised plan is worth
 * maximum_points (planned actions × 50) + a one-time 50pt plan_bonus_points, and each
 * commitment_wallet_event adds its points_awarded (50 for completed_on_time, 0 otherwise).
 * Exported for reuse by app/actions/admin-dashboard.ts. */
export async function loadCommitmentWalletByCohort(
  admin: ReturnType<typeof createAdminClient>,
  cohortIds: string[]
): Promise<Map<string, CohortCommitment>> {
  const result = new Map<string, CohortCommitment>();
  if (!cohortIds.length) return result;

  const { data: plans } = await admin
    .from("commitment_wallet_plans")
    .select("id, user_id, cohort_id, maximum_points, plan_bonus_points, planned_actions")
    .in("cohort_id", cohortIds);
  const planRows = (plans ?? []) as {
    id: string;
    user_id: string;
    cohort_id: string;
    maximum_points: number;
    plan_bonus_points: number;
    planned_actions: number;
  }[];
  if (!planRows.length) return result;

  const planIds = planRows.map((p) => p.id);
  const { data: events } = await admin
    .from("commitment_wallet_events")
    .select("plan_id, points_awarded, event_type")
    .in("plan_id", planIds);
  const eventRows = (events ?? []) as { plan_id: string; points_awarded: number; event_type: string }[];

  const actionPointsByPlan = new Map<string, number>();
  const missedByPlan = new Map<string, number>();
  const completedOnTimeByPlan = new Map<string, number>();
  for (const event of eventRows) {
    actionPointsByPlan.set(event.plan_id, (actionPointsByPlan.get(event.plan_id) ?? 0) + (event.points_awarded ?? 0));
    // Score drops only for outstanding misses (Pending validation / Didn't
    // complete). Late check-ins keep or restore the score.
    if (event.event_type === "missed") {
      missedByPlan.set(event.plan_id, (missedByPlan.get(event.plan_id) ?? 0) + 1);
    }
    if (event.event_type === "completed_on_time") {
      completedOnTimeByPlan.set(event.plan_id, (completedOnTimeByPlan.get(event.plan_id) ?? 0) + 1);
    }
  }

  for (const plan of planRows) {
    const actionPoints = actionPointsByPlan.get(plan.id) ?? 0;
    const points = plan.plan_bonus_points + actionPoints;
    const maximum = plan.maximum_points + plan.plan_bonus_points;
    const plannedActions = plan.planned_actions;
    const missedActions = missedByPlan.get(plan.id) ?? 0;
    const completedOnTimeActions = completedOnTimeByPlan.get(plan.id) ?? 0;

    const cohortEntry = result.get(plan.cohort_id) ?? {
      team: { points: 0, maximum: 0, planPoints: 0, actionPoints: 0, memberCount: 0, plannedActions: 0, missedActions: 0 },
      perUser: new Map<string, UserCommitment>(),
    };
    cohortEntry.team.points += points;
    cohortEntry.team.maximum += maximum;
    cohortEntry.team.planPoints += plan.plan_bonus_points;
    cohortEntry.team.actionPoints += actionPoints;
    cohortEntry.team.memberCount += 1;
    cohortEntry.team.plannedActions += plannedActions;
    cohortEntry.team.missedActions += missedActions;

    const existingUser = cohortEntry.perUser.get(plan.user_id);
    if (existingUser) {
      existingUser.points += points;
      existingUser.maximum += maximum;
      existingUser.plannedActions += plannedActions;
      existingUser.missedActions += missedActions;
      existingUser.completedOnTimeActions += completedOnTimeActions;
    } else {
      cohortEntry.perUser.set(plan.user_id, { points, maximum, plannedActions, missedActions, completedOnTimeActions });
    }

    result.set(plan.cohort_id, cohortEntry);
  }

  return result;
}

/** The real Commitment Score, matching get_my_commitment_wallet()'s formula (see
 * supabase/migrations/073_late_completion_keeps_commitment_score.sql) and what
 * participants see on /wallet: starts at 100% when a plan is finalised and drops
 * only for outstanding misses (Pending validation / Didn't complete). Completing
 * late keeps or restores the score. NOT the points-banked/maximum-points ratio.
 * Mirrors the identical helper in app/actions/admin-dashboard.ts. */
function walletScorePct(plannedActions: number, missedActions: number) {
  return plannedActions > 0 ? Math.round((Math.max(0, plannedActions - missedActions) * 100) / plannedActions) : 0;
}

/** Per-user count of action-reminder emails that were opened or clicked
 * (Resend webhook → email_campaign_logs.opened_at / clicked_at). Same open
 * rule as getEmailOpenRates: a click counts as an open if opened_at was never set.
 * Includes cohort-attributed sends plus older null-cohort rows for members in scope. */
export async function loadActionsReadByEmail(
  admin: ReturnType<typeof createAdminClient>,
  userIds: string[],
  cohortIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!userIds.length || !cohortIds.length) return result;

  const cohortIdSet = new Set(cohortIds);
  const userIdSet = new Set(userIds);

  const { data: attributedRows } = await admin
    .from("email_campaign_logs")
    .select("user_id, cohort_id, created_at, opened_at, clicked_at")
    .in("cohort_id", cohortIds)
    .in("user_id", userIds)
    .eq("template_id", "daily_reminder")
    .eq("status", "sent");

  const { data: unattributedRows } = await admin
    .from("email_campaign_logs")
    .select("user_id, cohort_id, created_at, opened_at, clicked_at")
    .is("cohort_id", null)
    .in("user_id", userIds)
    .eq("template_id", "daily_reminder")
    .eq("status", "sent");

  const seen = new Set<string>();
  for (const row of [...(attributedRows ?? []), ...(unattributedRows ?? [])] as {
    user_id: string | null;
    cohort_id: string | null;
    created_at: string;
    opened_at: string | null;
    clicked_at: string | null;
  }[]) {
    if (!row.user_id || !userIdSet.has(row.user_id)) continue;
    if (row.cohort_id && !cohortIdSet.has(row.cohort_id)) continue;
    const key = `${row.user_id}|${row.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const openedOrClicked = !!row.opened_at || !!row.clicked_at;
    if (!openedOrClicked) continue;
    result.set(row.user_id, (result.get(row.user_id) ?? 0) + 1);
  }

  return result;
}

export type MemberEmailOpenCounts = {
  /** Reminder opens + recap opens. */
  eitherOpened: number;
  reminderOpened: number;
  recapOpened: number;
};

/** Per-member opened counts for reminder and Friday recap (click ⇒ open). */
export async function loadMemberEmailOpenCounts(
  admin: ReturnType<typeof createAdminClient>,
  userIds: string[],
  cohortIds: string[]
): Promise<Map<string, MemberEmailOpenCounts>> {
  const result = new Map<string, MemberEmailOpenCounts>();
  if (!userIds.length || !cohortIds.length) return result;

  const cohortIdSet = new Set(cohortIds);
  const userIdSet = new Set(userIds);
  const emailTemplates = ["daily_reminder", "weekly_recap"] as const;

  const { data: attributedRows } = await admin
    .from("email_campaign_logs")
    .select("user_id, template_id, cohort_id, created_at, opened_at, clicked_at")
    .in("cohort_id", cohortIds)
    .in("user_id", userIds)
    .in("template_id", [...emailTemplates])
    .eq("status", "sent");

  const { data: unattributedRows } = await admin
    .from("email_campaign_logs")
    .select("user_id, template_id, cohort_id, created_at, opened_at, clicked_at")
    .is("cohort_id", null)
    .in("user_id", userIds)
    .in("template_id", [...emailTemplates])
    .eq("status", "sent");

  const seen = new Set<string>();
  for (const row of [...(attributedRows ?? []), ...(unattributedRows ?? [])] as {
    user_id: string | null;
    template_id: string;
    cohort_id: string | null;
    created_at: string;
    opened_at: string | null;
    clicked_at: string | null;
  }[]) {
    if (!row.user_id || !userIdSet.has(row.user_id)) continue;
    if (row.cohort_id && !cohortIdSet.has(row.cohort_id)) continue;
    const key = `${row.user_id}|${row.template_id}|${row.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const openedOrClicked = !!row.opened_at || !!row.clicked_at;
    if (!openedOrClicked) continue;

    const current = result.get(row.user_id) ?? { eitherOpened: 0, reminderOpened: 0, recapOpened: 0 };
    if (row.template_id === "daily_reminder") {
      current.reminderOpened += 1;
    } else if (row.template_id === "weekly_recap") {
      current.recapOpened += 1;
    } else {
      continue;
    }
    current.eitherOpened = current.reminderOpened + current.recapOpened;
    result.set(row.user_id, current);
  }

  return result;
}

/** Get company-scoped analytics. Superadmin must pass companyId. */
export async function getCompanyAnalytics(companyId?: string): Promise<{
  error?: string;
  usersCount?: number;
  actionsCount?: number;
  userActionsByStatus?: Record<string, number>;
  adoptionRate?: number;
}> {
  try {
    const { supabase, companyId: myCompanyId, role } = await getAdminContext();

    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) {
      return { error: "Company required" };
    }

    const { count: usersCount } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("company_id", resolvedCompanyId);

    const { count: actionsCount } = await supabase
      .from("actions")
      .select("id", { count: "exact", head: true })
      .eq("company_id", resolvedCompanyId);

    const { data: companyUsers } = await supabase
      .from("profiles")
      .select("id")
      .eq("company_id", resolvedCompanyId);
    const userIds = (companyUsers ?? []).map((u) => u.id);

    let userActionRows: { status: string }[] = [];
    if (userIds.length > 0) {
      const { data } = await supabase
        .from("user_actions")
        .select("status")
        .in("user_id", userIds);
      userActionRows = data ?? [];
    }

    const statusCounts: Record<string, number> = {};
    for (const row of userActionRows ?? []) {
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    }

    const total = (userActionRows ?? []).length;
    const successful = statusCounts["success"] ?? 0;
    const adoptionRate = total > 0 ? Math.round((successful / total) * 100) : 0;

    return {
      usersCount: usersCount ?? 0,
      actionsCount: actionsCount ?? 0,
      userActionsByStatus: statusCounts,
      adoptionRate,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

/** Behavioural journey funnel for Analytics tab. Uses admin client to read company users' user_actions. */
export async function getBehaviouralJourneyFunnel(companyId?: string): Promise<{
  error?: string;
  usersCount?: number;
  /** Total actions delivered = sum over packages of (package_actions count × assigned users count). */
  totalActionsDelivered?: number;
  /** Average actions per user (total delivered / users). */
  averageActionsPerUser?: number;
  /** Actions accepted by users (user_actions count). */
  intentionTotal?: number;
  /** Actions validated (user_actions with status success). */
  actionsValidated?: number;
  /** Average percentage of deliveries per user that have at least one user_action row. */
  consistentlyActivePct?: number;
  /** Users whose deliveries are all active (at least one user_action for every delivered action). */
  consistentlyActiveUsersCount?: number;
  /** Users with at least one user_action row. */
  actionReadersCount?: number;
  /** Percentage of users with at least one user_action row. */
  actionReadersPct?: number;
  /** Users who have validated an action (success). */
  actionTakersCount?: number;
  /** Percentage of users who have validated an action. */
  actionTakersPct?: number;
  /** Users with no user_action rows. */
  inactiveUsersCount?: number;
  /** Percentage of users with no user_action rows. */
  inactiveUsersPct?: number;
}> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) {
      return { error: "Company required" };
    }

    const admin = createAdminClient();

    const { data: companyProfiles } = await admin
      .from("profiles")
      .select("id, role")
      .eq("company_id", resolvedCompanyId);
    // Only include end-users in analytics; exclude company admins/superadmins.
    const userIds = (companyProfiles ?? [])
      .filter((p) => p.role === "user")
      .map((p) => p.id);
    const usersCount = userIds.length;

    // Company-wide engagement metrics initialised to 0; will be populated if we have data.
    let consistentlyActivePct = 0;
    let consistentlyActiveUsersCount = 0;
    let actionReadersCount = 0;
    let actionReadersPct = 0;
    let actionTakersCount = 0;
    let actionTakersPct = 0;
    let inactiveUsersCount = 0;
    let inactiveUsersPct = 0;

    let totalActionsDelivered = 0;
    const { data: packages } = await admin
      .from("packages")
      .select("id")
      .eq("company_id", resolvedCompanyId);
    const packageIds = (packages ?? []).map((p) => p.id);

    // Preload package_actions and package_assignments for all packages to compute per-user deliveries.
    let packageActions:
      | { package_id: string; action_id: string }[]
      | null = null;
    let packageAssignments:
      | { package_id: string; user_id: string }[]
      | null = null;
    if (packageIds.length > 0) {
      const { data: paRows } = await admin
        .from("package_actions")
        .select("package_id, action_id")
        .in("package_id", packageIds);
      const { data: assignRows } = await admin
        .from("package_assignments")
        .select("package_id, user_id")
        .in("package_id", packageIds);
      packageActions = paRows ?? [];
      packageAssignments = assignRows ?? [];
    }

    for (const pkg of packages ?? []) {
      const { count: paCount } = await admin
        .from("package_actions")
        .select("id", { count: "exact", head: true })
        .eq("package_id", pkg.id);
      const { count: assignCount } = await admin
        .from("package_assignments")
        .select("id", { count: "exact", head: true })
        .eq("package_id", pkg.id);
      totalActionsDelivered += (paCount ?? 0) * (assignCount ?? 0);
    }

    const averageActionsPerUser = usersCount > 0 ? Math.round((totalActionsDelivered / usersCount) * 10) / 10 : 0;

    let intentionTotal = 0;
    let actionsValidated = 0;
    if (userIds.length > 0) {
      const { data: uaRows } = await admin
        .from("user_actions")
        .select("user_id, action_id, status")
        .in("user_id", userIds);
      intentionTotal = (uaRows ?? []).length;

      // Build per-user user_action aggregates for engagement analytics.
      const userActionIdsByUser = new Map<string, Set<string>>();
      const usersWithAnyAction = new Set<string>();
      const actionTakersUsers = new Set<string>();

      for (const row of uaRows ?? []) {
        usersWithAnyAction.add(row.user_id);
        const existing = userActionIdsByUser.get(row.user_id) ?? new Set<string>();
        existing.add(row.action_id);
        userActionIdsByUser.set(row.user_id, existing);

        if (row.status === "success") {
          actionsValidated += 1;
          actionTakersUsers.add(row.user_id);
        }
      }

      // Derive per-user delivery coverage (consistency) using package assignments & actions.
      if (packageActions && packageAssignments && userIds.length > 0) {
        const actionsByPackage = new Map<string, string[]>();
        for (const pa of packageActions) {
          const list = actionsByPackage.get(pa.package_id) ?? [];
          list.push(pa.action_id);
          actionsByPackage.set(pa.package_id, list);
        }

        const deliveriesByUser = new Map<string, Set<string>>();
        for (const assign of packageAssignments) {
          const userId = assign.user_id;
          const actionIdsForPackage =
            actionsByPackage.get(assign.package_id) ?? [];
          if (actionIdsForPackage.length === 0) continue;

          const deliveredSet =
            deliveriesByUser.get(userId) ?? new Set<string>();
          for (const actionId of actionIdsForPackage) {
            deliveredSet.add(actionId);
          }
          deliveriesByUser.set(userId, deliveredSet);
        }

        let consistencySum = 0;
        let consistencyUsers = 0;

        for (const userId of userIds) {
          const deliveredSet = deliveriesByUser.get(userId);
          if (!deliveredSet || deliveredSet.size === 0) continue;

          const totalDelivered = deliveredSet.size;
          const userActionIds = userActionIdsByUser.get(userId);

          let activeDeliveries = 0;
          if (userActionIds) {
            for (const actionId of deliveredSet) {
              if (userActionIds.has(actionId)) {
                activeDeliveries += 1;
              }
            }
          }

          const ratio =
            totalDelivered > 0 ? activeDeliveries / totalDelivered : 0;
          consistencySum += ratio;
          consistencyUsers += 1;

          // User is "consistently active" if they have an action row for every delivered action.
          if (ratio === 1) {
            consistentlyActiveUsersCount += 1;
          }
        }

        if (consistencyUsers > 0) {
          consistentlyActivePct = Math.round(
            (consistencySum / consistencyUsers) * 100
          );
        }
      }

      actionReadersCount = usersWithAnyAction.size;
      inactiveUsersCount = Math.max(0, usersCount - actionReadersCount);
      actionTakersCount = actionTakersUsers.size;

      actionReadersPct =
        usersCount > 0
          ? Math.round((actionReadersCount / usersCount) * 100)
          : 0;
      inactiveUsersPct =
        usersCount > 0
          ? Math.round((inactiveUsersCount / usersCount) * 100)
          : 0;
      actionTakersPct =
        usersCount > 0
          ? Math.round((actionTakersCount / usersCount) * 100)
          : 0;
    }

    return {
      usersCount,
      totalActionsDelivered,
      averageActionsPerUser,
      intentionTotal,
      actionsValidated,
      consistentlyActivePct,
      consistentlyActiveUsersCount,
      actionReadersCount,
      actionReadersPct,
      actionTakersCount,
      actionTakersPct,
      inactiveUsersCount,
      inactiveUsersPct,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface EngagementLeaderboardEntry {
  id: string;
  name: string;
  /** Commitment buddy display name in scope (null when unpaired). */
  buddyName: string | null;
  commitmentPoints: number;
  commitmentMaximum: number;
  commitmentPct: number;
  plannedActions: number;
  completedOnTimeActions: number;
  missedActions: number;
  acceptedCount: number;
  validatedCount: number;
}

/** Per-user engagement leaderboard for admin User Engagement tab. Scoped to one batch when
 * cohortId is given (matching the batch selector shared with the Dashboard tab), or the whole
 * company when it's null/omitted ("All batches"). Ranked by Commitment Wallet points banked —
 * the app's real points system — summed across every batch the person has a plan in, within
 * scope. */
export async function getEngagementLeaderboard(companyId?: string, cohortId?: string | null): Promise<{
  entries: EngagementLeaderboardEntry[];
  error?: string;
}> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) {
      return { entries: [], error: "Company required" };
    }

    const admin = createAdminClient();

    let userProfiles: { id: string; full_name: string | null; role: string }[];
    if (cohortId) {
      const { data: memberRows } = await admin.from("cohort_members").select("user_id").eq("cohort_id", cohortId);
      const memberIds = [...new Set((memberRows ?? []).map((m: { user_id: string }) => m.user_id))];
      const { data: profiles } = memberIds.length
        ? await admin.from("profiles").select("id, full_name, role").in("id", memberIds)
        : { data: [] };
      userProfiles = (profiles ?? []).filter((p: { role: string }) => p.role === "user");
    } else {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, full_name, role")
        .eq("company_id", resolvedCompanyId);
      userProfiles = (profiles ?? []).filter((p: { role: string }) => p.role === "user");
    }
    const userIds = userProfiles.map((p) => p.id);

    type Counters = {
      acceptedCount: number;
      validatedCount: number;
    };

    const countersByUser = new Map<string, Counters>();
    for (const p of userProfiles) {
      countersByUser.set(p.id, { acceptedCount: 0, validatedCount: 0 });
    }

    if (userIds.length > 0) {
      let uaQuery = admin.from("user_actions").select("user_id, status").in("user_id", userIds);
      if (cohortId) uaQuery = uaQuery.eq("cohort_id", cohortId);
      const { data: uaRows } = await uaQuery;

      for (const row of (uaRows ?? []) as { user_id: string; status: string }[]) {
        const counters = countersByUser.get(row.user_id) ?? { acceptedCount: 0, validatedCount: 0 };

        const status = row.status;
        const wasAccepted = status === "scheduled" || status === "success" || status === "failed";

        if (wasAccepted) counters.acceptedCount += 1;
        if (status === "success") counters.validatedCount += 1;

        countersByUser.set(row.user_id, counters);
      }
    }

    let scopedCohortIds: string[];
    if (cohortId) {
      scopedCohortIds = [cohortId];
    } else {
      const { data: companyCohorts } = await admin
        .from("cohorts")
        .select("id")
        .eq("company_id", resolvedCompanyId);
      scopedCohortIds = (companyCohorts ?? []).map((c: { id: string }) => c.id);
    }
    const [commitmentByCohort, buddyAssignments] = await Promise.all([
      loadCommitmentWalletByCohort(admin, scopedCohortIds),
      scopedCohortIds.length && userIds.length
        ? admin
            .from("commitment_buddy_assignments")
            .select("user_id, buddy_user_id")
            .in("cohort_id", scopedCohortIds)
            .in("user_id", userIds)
        : Promise.resolve({ data: [] as { user_id: string; buddy_user_id: string }[] }),
    ]);

    const buddyIds = [
      ...new Set(
        ((buddyAssignments.data ?? []) as { buddy_user_id: string }[]).map((a) => a.buddy_user_id)
      ),
    ];
    const buddyNameById = new Map<string, string>();
    if (buddyIds.length) {
      const { data: buddyProfiles } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", buddyIds);
      for (const p of (buddyProfiles ?? []) as { id: string; full_name: string | null }[]) {
        buddyNameById.set(p.id, p.full_name?.trim() || "User");
      }
    }
    const buddyByUser = new Map<string, string>();
    for (const row of (buddyAssignments.data ?? []) as { user_id: string; buddy_user_id: string }[]) {
      const name = buddyNameById.get(row.buddy_user_id);
      if (!name) continue;
      const existing = buddyByUser.get(row.user_id);
      if (!existing) buddyByUser.set(row.user_id, name);
      else if (existing !== name && !existing.split(" / ").includes(name)) {
        buddyByUser.set(row.user_id, `${existing} / ${name}`);
      }
    }

    const commitmentByUser = new Map<string, UserCommitment>();
    for (const cohortCommitment of commitmentByCohort.values()) {
      for (const [userId, userCommitment] of cohortCommitment.perUser) {
        const existing = commitmentByUser.get(userId);
        if (existing) {
          existing.points += userCommitment.points;
          existing.maximum += userCommitment.maximum;
          existing.plannedActions += userCommitment.plannedActions;
          existing.missedActions += userCommitment.missedActions;
          existing.completedOnTimeActions += userCommitment.completedOnTimeActions;
        } else {
          commitmentByUser.set(userId, { ...userCommitment });
        }
      }
    }

    const entries: EngagementLeaderboardEntry[] = userProfiles.map(
      (p) => {
        const counters = countersByUser.get(p.id) ?? ({ acceptedCount: 0, validatedCount: 0 } as Counters);
        const commitment = commitmentByUser.get(p.id);

        return {
          id: p.id,
          name: p.full_name?.trim() || "User",
          buddyName: buddyByUser.get(p.id) ?? null,
          commitmentPoints: commitment?.points ?? 0,
          commitmentMaximum: commitment?.maximum ?? 0,
          commitmentPct: walletScorePct(commitment?.plannedActions ?? 0, commitment?.missedActions ?? 0),
          plannedActions: commitment?.plannedActions ?? 0,
          completedOnTimeActions: commitment?.completedOnTimeActions ?? 0,
          missedActions: commitment?.missedActions ?? 0,
          acceptedCount: counters.acceptedCount,
          validatedCount: counters.validatedCount,
        };
      }
    );

    // Sort by commitment points banked descending for leaderboard rank.
    entries.sort((a, b) => b.commitmentPoints - a.commitmentPoints);

    return { entries };
  } catch (e) {
    return {
      entries: [],
      error: e instanceof Error ? e.message : "Failed",
    };
  }
}

const ACTION_ACCEPTED_STATUSES = ["scheduled", "success", "failed"];

export interface WeeklyActionChartEntry {
  weekNumber: number;
  name: string;
  /** Actions on the plan for this week (any status). */
  planned: number;
  /** Validated / completed successfully. */
  validated: number;
  /** Auto-expired fails awaiting validation — same as Actions "Pending validation". */
  pending: number;
  /** Confirmed fails/skips — same as Actions "Didn't complete". */
  didntComplete: number;
  /** Inclusive IST dates of this week from the first delivery; null when batches differ. */
  weekStartIst: string | null;
  weekEndIst: string | null;
}

/** Empty weekly bucket — shared by company-wide and per-batch chart builders. */
function emptyWeeklyBucket() {
  return { planned: 0, validated: 0, pending: 0, didntComplete: 0 };
}

/** Classify a user_action into the same planned / validated / pending / didn't-complete
 * buckets as the batch members table and participant Actions tabs. */
function bumpWeeklyBucket(
  bucket: { planned: number; validated: number; pending: number; didntComplete: number },
  status: string,
  autoExpired: boolean | null
) {
  bucket.planned += 1;
  if (status === "success") {
    bucket.validated += 1;
  } else if (status === "failed" && autoExpired) {
    bucket.pending += 1;
  } else if ((status === "failed" || status === "skipped") && !autoExpired) {
    bucket.didntComplete += 1;
  }
}

/** Per-week action stats for the legacy Analytics tab. Buckets match the Batches
 * drill-down: planned, validated, pending validation, didn't complete. */
export async function getWeeklyActionChartData(companyId?: string): Promise<{
  entries: WeeklyActionChartEntry[];
  error?: string;
}> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) {
      return { entries: [], error: "Company required" };
    }

    const admin = createAdminClient();

    const { data: companyProfiles } = await admin
      .from("profiles")
      .select("id, role")
      .eq("company_id", resolvedCompanyId);
    const endUserIds = (companyProfiles ?? [])
      .filter((p: { role: string }) => p.role === "user")
      .map((p: { id: string }) => p.id);
    if (!endUserIds.length) return { entries: [] };

    const { data: cohorts } = await admin
      .from("cohorts")
      .select("id, created_at")
      .eq("company_id", resolvedCompanyId)
      .is("archived_at", null);
    const cohortRows = (cohorts ?? []) as { id: string; created_at: string }[];
    if (!cohortRows.length) return { entries: [] };

    const anchors = await resolveCohortWeekAnchors(
      admin,
      cohortRows.map((c) => c.id)
    );

    const { data: uaRows } = await admin
      .from("user_actions")
      .select("cohort_id, status, auto_expired, scheduled_at, accepted_at, created_at")
      .in("user_id", endUserIds)
      .in(
        "cohort_id",
        cohortRows.map((c) => c.id)
      );

    let maxWeek = chartWeekCount(
      anchors,
      await resolveCohortMaxWeeks(
        admin,
        cohortRows.map((c) => c.id)
      )
    );

    const weeklyBuckets = new Map<number, ReturnType<typeof emptyWeeklyBucket>>();
    for (const row of (uaRows ?? []) as {
      cohort_id: string | null;
      status: string;
      auto_expired: boolean | null;
      scheduled_at: string | null;
      accepted_at: string | null;
      created_at: string;
    }[]) {
      const anchor = row.cohort_id ? anchors.get(row.cohort_id) : undefined;
      if (!anchor) continue;
      const whenIso = row.scheduled_at ?? row.accepted_at ?? row.created_at;
      if (!whenIso) continue;
      const week = weekNumberFor(new Date(whenIso), anchor);
      maxWeek = Math.max(maxWeek, week);
      const bucket = weeklyBuckets.get(week) ?? emptyWeeklyBucket();
      bumpWeeklyBucket(bucket, row.status, row.auto_expired);
      weeklyBuckets.set(week, bucket);
    }

    if (!weeklyBuckets.size) return { entries: [] };

    const displayAnchor = sharedWeekAnchor(anchors.values());
    const entries: WeeklyActionChartEntry[] = [];
    for (let weekNum = 1; weekNum <= maxWeek; weekNum++) {
      const b = weeklyBuckets.get(weekNum) ?? emptyWeeklyBucket();
      entries.push({
        weekNumber: weekNum,
        name: `Week ${weekNum}`,
        planned: b.planned,
        validated: b.validated,
        pending: b.pending,
        didntComplete: b.didntComplete,
        ...weekRangeFields(weekNum, displayAnchor),
      });
    }

    return { entries };
  } catch (e) {
    return {
      entries: [],
      error: e instanceof Error ? e.message : "Failed",
    };
  }
}

/** Shared per-user rollup used by both the cohort comparison table and the single-cohort
 * drill-down below — same math as getBehaviouralJourneyFunnel's funnel, scoped to whatever
 * user set (a cohort's members) is passed in. */
function summarizeCohortFunnel(
  userIds: string[],
  deliveriesByUser: Map<string, Set<string>>,
  userActionIdsByUser: Map<string, Set<string>>,
  usersWithAnyAction: Set<string>,
  usersWithSuccess: Set<string>
) {
  let totalActionsDelivered = 0;
  let consistencySum = 0;
  let consistencyUsers = 0;
  let actionReadersCount = 0;
  let actionTakersCount = 0;

  for (const userId of userIds) {
    const delivered = deliveriesByUser.get(userId);
    if (delivered) totalActionsDelivered += delivered.size;
    if (usersWithAnyAction.has(userId)) actionReadersCount += 1;
    if (usersWithSuccess.has(userId)) actionTakersCount += 1;
    if (delivered && delivered.size > 0) {
      const userActionIds = userActionIdsByUser.get(userId);
      let active = 0;
      if (userActionIds) {
        for (const actionId of delivered) {
          if (userActionIds.has(actionId)) active += 1;
        }
      }
      consistencySum += active / delivered.size;
      consistencyUsers += 1;
    }
  }

  const memberCount = userIds.length;
  return {
    memberCount,
    actionReadersCount,
    actionReadersPct: memberCount > 0 ? Math.round((actionReadersCount / memberCount) * 100) : 0,
    actionTakersCount,
    actionTakersPct: memberCount > 0 ? Math.round((actionTakersCount / memberCount) * 100) : 0,
    consistentlyActivePct: consistencyUsers > 0 ? Math.round((consistencySum / consistencyUsers) * 100) : 0,
    totalActionsDelivered,
    averageActionsPerUser: memberCount > 0 ? Math.round((totalActionsDelivered / memberCount) * 10) / 10 : 0,
  };
}

export interface CohortAnalyticsSummary {
  cohortId: string;
  batchName: string;
  moduleName: string | null;
  memberCount: number;
  actionReadersCount: number;
  actionReadersPct: number;
  actionTakersCount: number;
  actionTakersPct: number;
  consistentlyActivePct: number;
  totalActionsDelivered: number;
  averageActionsPerUser: number;
  commitmentPoints: number;
  commitmentMaximum: number;
  commitmentPct: number;
}

/** Per-cohort rollup of the same funnel shown on the company Dashboard, for the Cohorts
 * analytics comparison table (one row per cohort, all cohorts in the company at once). */
export async function getCohortAnalyticsOverview(companyId?: string): Promise<{
  entries: CohortAnalyticsSummary[];
  error?: string;
}> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) {
      return { entries: [], error: "Company required" };
    }

    const admin = createAdminClient();

    const { data: cohorts } = await admin
      .from("cohorts")
      .select("id, batch_name, module_name")
      .eq("company_id", resolvedCompanyId)
      .is("archived_at", null)
      .order("created_at", { ascending: false });
    if (!cohorts?.length) return { entries: [] };
    const cohortIds = cohorts.map((c: { id: string }) => c.id);

    const { data: memberRows } = await admin
      .from("cohort_members")
      .select("cohort_id, user_id")
      .in("cohort_id", cohortIds);

    const memberUserIds = [...new Set((memberRows ?? []).map((m: { user_id: string }) => m.user_id))];
    const { data: profiles } = memberUserIds.length
      ? await admin.from("profiles").select("id, role").in("id", memberUserIds)
      : { data: [] as { id: string; role: string }[] };
    const profileMap = new Map(
      (profiles ?? [])
        .filter((p: { role: string }) => p.role === "user")
        .map((p: { id: string }) => [p.id, p])
    );

    const { data: packages } = await admin.from("packages").select("id").eq("company_id", resolvedCompanyId);
    const packageIds = (packages ?? []).map((p: { id: string }) => p.id);

    let packageActions: { package_id: string; action_id: string }[] = [];
    let assignments: { package_id: string; user_id: string }[] = [];
    if (packageIds.length > 0) {
      const [{ data: paRows }, { data: assignRows }] = await Promise.all([
        admin.from("package_actions").select("package_id, action_id").in("package_id", packageIds),
        admin.from("package_assignments").select("package_id, user_id").in("package_id", packageIds),
      ]);
      packageActions = paRows ?? [];
      assignments = assignRows ?? [];
    }

    const actionsByPackage = new Map<string, string[]>();
    for (const pa of packageActions) {
      const list = actionsByPackage.get(pa.package_id) ?? [];
      list.push(pa.action_id);
      actionsByPackage.set(pa.package_id, list);
    }

    const deliveriesByUser = new Map<string, Set<string>>();
    for (const a of assignments) {
      const actionIds = actionsByPackage.get(a.package_id) ?? [];
      if (!actionIds.length) continue;
      const set = deliveriesByUser.get(a.user_id) ?? new Set<string>();
      actionIds.forEach((id) => set.add(id));
      deliveriesByUser.set(a.user_id, set);
    }

    const relevantUserIds = memberUserIds.filter((id) => profileMap.has(id));
    const { data: uaRows } = relevantUserIds.length
      ? await admin.from("user_actions").select("user_id, action_id, status").in("user_id", relevantUserIds)
      : { data: [] as { user_id: string; action_id: string; status: string }[] };

    const userActionIdsByUser = new Map<string, Set<string>>();
    const usersWithAnyAction = new Set<string>();
    const usersWithSuccess = new Set<string>();
    for (const row of (uaRows ?? []) as { user_id: string; action_id: string; status: string }[]) {
      usersWithAnyAction.add(row.user_id);
      const set = userActionIdsByUser.get(row.user_id) ?? new Set<string>();
      set.add(row.action_id);
      userActionIdsByUser.set(row.user_id, set);
      if (row.status === "success") usersWithSuccess.add(row.user_id);
    }

    const membersByCohort = new Map<string, string[]>();
    for (const row of (memberRows ?? []) as { cohort_id: string; user_id: string }[]) {
      if (!profileMap.has(row.user_id)) continue;
      const list = membersByCohort.get(row.cohort_id) ?? [];
      list.push(row.user_id);
      membersByCohort.set(row.cohort_id, list);
    }

    const commitmentByCohort = await loadCommitmentWalletByCohort(admin, cohortIds);

    const entries: CohortAnalyticsSummary[] = (
      cohorts as { id: string; batch_name: string; module_name: string | null }[]
    ).map((cohort) => {
      const userIds = membersByCohort.get(cohort.id) ?? [];
      const summary = summarizeCohortFunnel(
        userIds,
        deliveriesByUser,
        userActionIdsByUser,
        usersWithAnyAction,
        usersWithSuccess
      );
      const team = commitmentByCohort.get(cohort.id)?.team;
      return {
        cohortId: cohort.id,
        batchName: cohort.batch_name,
        moduleName: cohort.module_name,
        ...summary,
        commitmentPoints: team?.points ?? 0,
        commitmentMaximum: team?.maximum ?? 0,
        commitmentPct: walletScorePct(team?.plannedActions ?? 0, team?.missedActions ?? 0),
      };
    });

    return { entries };
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface CohortMemberEngagement {
  id: string;
  name: string;
  commitmentPoints: number;
  commitmentMaximum: number;
  commitmentPct: number;
  plannedActions: number;
  completedOnTimeActions: number;
  /** Reminder + recap emails opened or clicked. */
  actionsReadCount: number;
  reminderOpenedCount: number;
  recapOpenedCount: number;
  /** Auto-expired failures still awaiting participant confirm — matches Actions "Pending validation". */
  pendingValidationCount: number;
  /** Confirmed fails/skips — matches Actions "Didn't complete". */
  notCompletedCount: number;
  acceptedCount: number;
  validatedCount: number;
}

export interface CohortAnalyticsDetail extends CohortAnalyticsSummary {
  weeklyChart: WeeklyActionChartEntry[];
  /** Unique users emailed per week: either (reminder∪recap), reminder, weekly recap. */
  weeklyEmailChart: WeeklyEmailChartEntry[];
  members: CohortMemberEngagement[];
}

export interface WeeklyEmailChartEntry {
  weekNumber: number;
  name: string;
  eitherMailUsers: number;
  reminderUsers: number;
  recapUsers: number;
  weekStartIst: string | null;
  weekEndIst: string | null;
}

/** Unique recipients of reminder / Friday recap emails per cohort week — same
 * either∪reminder∪recap definition as the Dashboard combined mail chart. */
async function loadWeeklyEmailReachChart(
  admin: ReturnType<typeof createAdminClient>,
  cohortId: string,
  userIds: string[],
  cohortAnchor: Date,
  maxWeek: number
): Promise<WeeklyEmailChartEntry[]> {
  if (!userIds.length) return [];

  const userIdSet = new Set(userIds);
  const emailTemplates = ["daily_reminder", "weekly_recap"] as const;

  const { data: attributedRows } = await admin
    .from("email_campaign_logs")
    .select("user_id, template_id, cohort_id, created_at")
    .eq("cohort_id", cohortId)
    .in("user_id", userIds)
    .in("template_id", [...emailTemplates])
    .eq("status", "sent");

  const { data: unattributedRows } = await admin
    .from("email_campaign_logs")
    .select("user_id, template_id, cohort_id, created_at")
    .is("cohort_id", null)
    .in("user_id", userIds)
    .in("template_id", [...emailTemplates])
    .eq("status", "sent");

  type WeekMailBucket = { reminderUserIds: Set<string>; recapUserIds: Set<string> };
  const weeklyMap = new Map<number, WeekMailBucket>();
  const emptyMailWeek = (): WeekMailBucket => ({
    reminderUserIds: new Set(),
    recapUserIds: new Set(),
  });

  const seen = new Set<string>();
  let emailMaxWeek = 0;
  for (const row of [...(attributedRows ?? []), ...(unattributedRows ?? [])] as {
    user_id: string | null;
    template_id: string;
    cohort_id: string | null;
    created_at: string;
  }[]) {
    if (!row.user_id || !userIdSet.has(row.user_id)) continue;
    if (row.cohort_id && row.cohort_id !== cohortId) continue;
    const key = `${row.user_id}|${row.template_id}|${row.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const week = weekNumberFor(new Date(row.created_at), cohortAnchor);
    emailMaxWeek = Math.max(emailMaxWeek, week);
    const bucket = weeklyMap.get(week) ?? emptyMailWeek();
    if (row.template_id === "daily_reminder") {
      bucket.reminderUserIds.add(row.user_id);
    } else if (row.template_id === "weekly_recap") {
      bucket.recapUserIds.add(row.user_id);
    }
    weeklyMap.set(week, bucket);
  }

  if (!weeklyMap.size) return [];

  const chartMaxWeek = Math.max(maxWeek, emailMaxWeek, 1);
  const chart: WeeklyEmailChartEntry[] = [];
  for (let weekNum = 1; weekNum <= chartMaxWeek; weekNum++) {
    const b = weeklyMap.get(weekNum) ?? emptyMailWeek();
    const either = new Set(b.reminderUserIds);
    for (const id of b.recapUserIds) either.add(id);
    chart.push({
      weekNumber: weekNum,
      name: `Week ${weekNum}`,
      eitherMailUsers: either.size,
      reminderUsers: b.reminderUserIds.size,
      recapUsers: b.recapUserIds.size,
      ...weekRangeFields(weekNum, cohortAnchor),
    });
  }
  return chart;
}

/** Full funnel + weekly chart + per-member leaderboard for one cohort, used by the Cohorts
 * analytics page's drill-down. */
export async function getCohortAnalyticsDetail(cohortId: string): Promise<{
  detail?: CohortAnalyticsDetail;
  error?: string;
}> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const admin = createAdminClient();

    const { data: cohort } = await admin
      .from("cohorts")
      .select("id, batch_name, module_name, company_id, created_at, max_weeks")
      .eq("id", cohortId)
      .maybeSingle();
    if (!cohort) return { error: "Batch not found" };
    if (role === "admin" && cohort.company_id !== myCompanyId) return { error: "Access denied" };

    const { data: memberRows } = await admin.from("cohort_members").select("user_id").eq("cohort_id", cohortId);
    const memberIds = (memberRows ?? []).map((m: { user_id: string }) => m.user_id);

    const { data: profiles } = memberIds.length
      ? await admin.from("profiles").select("id, full_name, role").in("id", memberIds)
      : {
          data: [] as {
            id: string;
            full_name: string | null;
            role: string;
          }[],
        };
    const userProfiles = (profiles ?? []).filter((p: { role: string }) => p.role === "user");
    const userIds = userProfiles.map((p: { id: string }) => p.id);

    const { data: packages } = await admin.from("packages").select("id").eq("company_id", cohort.company_id);
    const packageIds = (packages ?? []).map((p: { id: string }) => p.id);

    let packageActions: { package_id: string; action_id: string; week_number: number | null }[] = [];
    let assignments: { package_id: string; user_id: string }[] = [];
    if (packageIds.length > 0 && userIds.length > 0) {
      const [{ data: paRows }, { data: assignRows }] = await Promise.all([
        admin.from("package_actions").select("package_id, action_id, week_number").in("package_id", packageIds),
        admin
          .from("package_assignments")
          .select("package_id, user_id")
          .in("package_id", packageIds)
          .in("user_id", userIds),
      ]);
      packageActions = paRows ?? [];
      assignments = assignRows ?? [];
    }

    const { data: uaRows } = userIds.length
      ? await admin
          .from("user_actions")
          .select("user_id, action_id, status, auto_expired, cohort_id, scheduled_at, accepted_at, created_at")
          .in("user_id", userIds)
          .eq("cohort_id", cohortId)
      : {
          data: [] as {
            user_id: string;
            action_id: string;
            status: string;
            auto_expired: boolean | null;
            cohort_id: string | null;
            scheduled_at: string | null;
            accepted_at: string | null;
            created_at: string;
          }[],
        };

    const actionsByPackage = new Map<string, string[]>();
    for (const pa of packageActions) {
      const list = actionsByPackage.get(pa.package_id) ?? [];
      list.push(pa.action_id);
      actionsByPackage.set(pa.package_id, list);
    }
    const deliveriesByUser = new Map<string, Set<string>>();
    for (const a of assignments) {
      const actionIds = actionsByPackage.get(a.package_id) ?? [];
      if (!actionIds.length) continue;
      const set = deliveriesByUser.get(a.user_id) ?? new Set<string>();
      actionIds.forEach((id) => set.add(id));
      deliveriesByUser.set(a.user_id, set);
    }

    const userActionIdsByUser = new Map<string, Set<string>>();
    const usersWithAnyAction = new Set<string>();
    const usersWithSuccess = new Set<string>();
    const acceptedByUser = new Map<string, number>();
    const validatedByUser = new Map<string, number>();
    const pendingValidationByUser = new Map<string, number>();
    const notCompletedByUser = new Map<string, number>();
    for (const row of (uaRows ?? []) as {
      user_id: string;
      action_id: string;
      status: string;
      auto_expired: boolean | null;
    }[]) {
      usersWithAnyAction.add(row.user_id);
      const set = userActionIdsByUser.get(row.user_id) ?? new Set<string>();
      set.add(row.action_id);
      userActionIdsByUser.set(row.user_id, set);
      if (ACTION_ACCEPTED_STATUSES.includes(row.status)) {
        acceptedByUser.set(row.user_id, (acceptedByUser.get(row.user_id) ?? 0) + 1);
      }
      if (row.status === "success") {
        usersWithSuccess.add(row.user_id);
        validatedByUser.set(row.user_id, (validatedByUser.get(row.user_id) ?? 0) + 1);
      }
      // Same split as participant Actions tabs (actions-client.tsx).
      if (row.status === "failed" && row.auto_expired) {
        pendingValidationByUser.set(row.user_id, (pendingValidationByUser.get(row.user_id) ?? 0) + 1);
      } else if ((row.status === "failed" || row.status === "skipped") && !row.auto_expired) {
        notCompletedByUser.set(row.user_id, (notCompletedByUser.get(row.user_id) ?? 0) + 1);
      }
    }

    const emailOpensByUser = await loadMemberEmailOpenCounts(admin, userIds, [cohortId]);

    const summary = summarizeCohortFunnel(
      userIds,
      deliveriesByUser,
      userActionIdsByUser,
      usersWithAnyAction,
      usersWithSuccess
    );
    const commitmentByCohort = await loadCommitmentWalletByCohort(admin, [cohortId]);
    const cohortCommitment = commitmentByCohort.get(cohortId);
    const team = cohortCommitment?.team;

    // Weekly chart from real user_actions (AI action plans), not package_actions —
    // packages are no longer how most batches deliver work, so package-based weeks were empty.
    const cohortAnchors = await resolveCohortWeekAnchors(admin, [cohortId]);
    const cohortAnchor =
      cohortAnchors.get(cohortId) ?? weekAnchorFromTimestamp(cohort.created_at);
    let maxWeek = chartWeekCount(new Map([[cohortId, cohortAnchor]]), new Map([[cohortId, cohort.max_weeks]]));
    const weeklyBuckets = new Map<number, ReturnType<typeof emptyWeeklyBucket>>();
    for (const row of (uaRows ?? []) as {
      status: string;
      auto_expired: boolean | null;
      scheduled_at: string | null;
      accepted_at: string | null;
      created_at: string;
    }[]) {
      const whenIso = row.scheduled_at ?? row.accepted_at ?? row.created_at;
      if (!whenIso) continue;
      const week = weekNumberFor(new Date(whenIso), cohortAnchor);
      maxWeek = Math.max(maxWeek, week);
      const bucket = weeklyBuckets.get(week) ?? emptyWeeklyBucket();
      bumpWeeklyBucket(bucket, row.status, row.auto_expired);
      weeklyBuckets.set(week, bucket);
    }
    const weeklyChart: WeeklyActionChartEntry[] = [];
    if (weeklyBuckets.size > 0) {
      for (let weekNum = 1; weekNum <= maxWeek; weekNum++) {
        const b = weeklyBuckets.get(weekNum) ?? emptyWeeklyBucket();
        weeklyChart.push({
          weekNumber: weekNum,
          name: `Week ${weekNum}`,
          planned: b.planned,
          validated: b.validated,
          pending: b.pending,
          didntComplete: b.didntComplete,
          ...weekRangeFields(weekNum, cohortAnchor),
        });
      }
    }

    const weeklyEmailChart = await loadWeeklyEmailReachChart(
      admin,
      cohortId,
      userIds,
      cohortAnchor,
      maxWeek
    );

    const members: CohortMemberEngagement[] = (
      userProfiles as { id: string; full_name: string | null }[]
    )
      .map((p) => {
        const commitment = cohortCommitment?.perUser.get(p.id);
        const emailOpens = emailOpensByUser.get(p.id);
        return {
          id: p.id,
          name: p.full_name?.trim() || "User",
          commitmentPoints: commitment?.points ?? 0,
          commitmentMaximum: commitment?.maximum ?? 0,
          commitmentPct: walletScorePct(commitment?.plannedActions ?? 0, commitment?.missedActions ?? 0),
          plannedActions: commitment?.plannedActions ?? 0,
          completedOnTimeActions: commitment?.completedOnTimeActions ?? 0,
          actionsReadCount: emailOpens?.eitherOpened ?? 0,
          reminderOpenedCount: emailOpens?.reminderOpened ?? 0,
          recapOpenedCount: emailOpens?.recapOpened ?? 0,
          pendingValidationCount: pendingValidationByUser.get(p.id) ?? 0,
          notCompletedCount: notCompletedByUser.get(p.id) ?? 0,
          acceptedCount: acceptedByUser.get(p.id) ?? 0,
          validatedCount: validatedByUser.get(p.id) ?? 0,
        };
      })
      // Same ranking as the Dashboard leaderboard (getDashboardLeaderboard): by commitment
      // score % first, raw points as tiebreaker.
      .sort((a, b) => b.commitmentPct - a.commitmentPct || b.commitmentPoints - a.commitmentPoints);

    return {
      detail: {
        cohortId: cohort.id,
        batchName: cohort.batch_name,
        moduleName: cohort.module_name,
        ...summary,
        commitmentPoints: team?.points ?? 0,
        commitmentMaximum: team?.maximum ?? 0,
        commitmentPct: walletScorePct(team?.plannedActions ?? 0, team?.missedActions ?? 0),
        weeklyChart,
        weeklyEmailChart,
        members,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export interface CompanyCommitmentSummary {
  commitmentPoints: number;
  commitmentMaximum: number;
  commitmentPct: number;
  planPoints: number;
  actionPoints: number;
  memberCount: number;
  batchCount: number;
}

/** Company-wide Commitment Wallet rollup — total points banked across every batch's finalised
 * plans, for the Dashboard. Same source data as the participant Wallet's team bucket and the
 * Batches analytics page, just summed across all of a company's batches instead of one. */
export async function getCompanyCommitmentSummary(companyId?: string): Promise<{
  summary?: CompanyCommitmentSummary;
  error?: string;
}> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? myCompanyId : companyId;
    if (!resolvedCompanyId) {
      return { error: "Company required" };
    }

    const admin = createAdminClient();

    const { data: cohorts } = await admin
      .from("cohorts")
      .select("id")
      .eq("company_id", resolvedCompanyId)
      .is("archived_at", null);
    const cohortIds = (cohorts ?? []).map((c: { id: string }) => c.id);

    const commitmentByCohort = await loadCommitmentWalletByCohort(admin, cohortIds);

    let points = 0;
    let maximum = 0;
    let planPoints = 0;
    let actionPoints = 0;
    let memberCount = 0;
    let batchCount = 0;
    let plannedActions = 0;
    let missedActions = 0;
    for (const { team } of commitmentByCohort.values()) {
      points += team.points;
      maximum += team.maximum;
      planPoints += team.planPoints;
      actionPoints += team.actionPoints;
      memberCount += team.memberCount;
      batchCount += 1;
      plannedActions += team.plannedActions;
      missedActions += team.missedActions;
    }

    return {
      summary: {
        commitmentPoints: points,
        commitmentMaximum: maximum,
        commitmentPct: walletScorePct(plannedActions, missedActions),
        planPoints,
        actionPoints,
        memberCount,
        batchCount,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}
