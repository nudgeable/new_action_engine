"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { UserProfile, UserAction, FeedItem, ActionCard, type CohortOption } from "./types";
import {
  declineAction as declineActionServer,
  completeAction as completeActionServer,
} from "@/app/actions/user-actions";
import { validateAction as validateActionServer } from "@/app/actions/validate-action";
import { dismissCommitmentWalletValidation as dismissPendingValidationServer } from "@/app/actions/commitment-wallet";
import { utcToISTDateTime } from "@/lib/timezone-utils";

export type GenerationJobStatus = {
  id: string;
  totalNeeded: number;
  totalGenerated: number;
  status: string;
  errorMessage?: string;
};

interface EngineContextType {
  profile: UserProfile;
  userActions: UserAction[];
  allActions: ActionCard[];
  /** Null until the user completes the self-serve AI action onboarding wizard. */
  selfOnboardingCompletedAt: string | null;
  /** Authoritative lifecycle of the personal plan subscription. */
  personalPlanState: "none" | "draft" | "active" | "archived";
  hasArchivedPlans: boolean;
  /** Cohort currently selected for every participant page. */
  cohort: CohortOption | null;
  cohorts: CohortOption[];
  feed: FeedItem[];
  isLoading: boolean;
  hasCompany: boolean;
  /** Live progress of the background action-plan generation job, while one is running. */
  generationJob: GenerationJobStatus | null;
  generationError: string | null;
  refreshGenerationStatus: (options?: { refreshActions?: boolean }) => Promise<GenerationJobStatus | null>;
  refetch: (options?: { syncPoints?: boolean }) => Promise<void>;
  completeOnboarding: (importance: number, goal: number) => Promise<void>;
  updatePoints: (amount: number) => Promise<void>;
  /**
   * Settles an action, then reloads the store. Pass `waitForRefresh: false` to
   * return as soon as it's saved and reload in the background (the "I did it"
   * celebration and box reveal don't need the reload first).
   */
  completeAction: (actionId: string, success: boolean, reflection?: string, options?: { waitForRefresh?: boolean }) => Promise<{
    error?: string;
    pointsDelta?: number;
    currentPoints?: number;
    completedLate?: boolean;
    surpriseBoxUnlockId?: string;
  }>;
  declineAction: (actionId: string) => Promise<void>;
  /** Confirm a Pending validation action really wasn't done — moves it into Didn't complete for good. */
  dismissPendingValidation: (actionId: string) => Promise<{ error?: string }>;
  retryAction: (actionId: string) => Promise<void>;
  validateAction: (userActionId: string, success: boolean, reflection?: string) => Promise<void>;
  addFeedItem: (type: FeedItem["type"], actionTitle: string) => Promise<void>;
  likeFeedItem: (id: string) => Promise<void>;
  addNewAction: (action: Omit<ActionCard, "id">) => Promise<void>;
}

const EngineContext = createContext<EngineContextType | undefined>(undefined);

function mapDbAction(row: { id: string; cohort_id?: string | null; plan_order?: number | null; theme: string; title: string; how: string; why: string; time_estimate: string; is_personal?: boolean | null; plan_points?: number | null; image_url?: string | null; category?: string | null }): ActionCard {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    planOrder: row.plan_order ?? null,
    theme: row.theme as ActionCard["theme"],
    title: row.title,
    how: row.how,
    why: row.why,
    timeEstimate: row.time_estimate ?? "5 mins",
    isPersonal: row.is_personal ?? false,
    planPoints: row.plan_points ?? undefined,
    imageUrl: row.image_url ?? null,
    category: row.category ?? null,
  };
}

function mapDbUserAction(row: {
  id: string;
  action_id: string;
  cohort_id?: string | null;
  status: string;
  scheduled_at: string | null;
  accepted_at: string | null;
  completed_at?: string | null;
  completed_late?: boolean | null;
  missed_at?: string | null;
  auto_expired?: boolean | null;
  reflection: string | null;
  is_calendar_synced: boolean;
  points_delta?: number | null;
  points_settled_at?: string | null;
}): UserAction {
  // Convert UTC timestamps to IST for display
  const scheduledIST = row.scheduled_at ? utcToISTDateTime(row.scheduled_at) : null;
  const acceptedIST = row.accepted_at ? utcToISTDateTime(row.accepted_at) : null;

  return {
    id: row.id,
    actionId: row.action_id,
    cohortId: row.cohort_id,
    status: row.status as UserAction["status"],
    scheduledDate: scheduledIST?.date,
    scheduledTime: scheduledIST?.time,
    scheduledAt: row.scheduled_at ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    acceptedDate: acceptedIST?.date,
    acceptedTime: acceptedIST?.time,
    completedAt: row.completed_at ?? undefined,
    completedLate: row.completed_late === true,
    missedAt: row.missed_at ?? undefined,
    autoExpired: row.auto_expired === true,
    isCalendarSynced: row.is_calendar_synced ?? false,
    reflection: row.reflection ?? undefined,
    pointsDelta: row.points_delta ?? undefined,
    pointsSettledAt: row.points_settled_at ?? undefined,
  };
}

function mapDbFeedEvent(row: { id: string; cohort_id?: string | null; user_id: string; action_title: string; type: string; likes: number; created_at: string }): FeedItem {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    userId: row.user_id,
    userName: "",
    actionTitle: row.action_title,
    type: row.type as FeedItem["type"],
    timestamp: new Date(row.created_at).getTime(),
    likes: row.likes ?? 0,
  };
}

export const EngineProvider: React.FC<{ children: React.ReactNode; adminCompanyId?: string | null }> = ({ children, adminCompanyId }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile>({
    name: "User",
    importanceRating: 5,
    weeklyGoal: 3,
    totalPoints: 0,
    onboarded: true,
    streak: 0,
  });
  const [allActions, setAllActions] = useState<ActionCard[]>([]);
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [selfOnboardingCompletedAt, setSelfOnboardingCompletedAt] = useState<string | null>(null);
  const [personalPlanState, setPersonalPlanState] = useState<"none" | "draft" | "active" | "archived">("none");
  const [hasArchivedPlans, setHasArchivedPlans] = useState(false);
  const [cohort, setCohort] = useState<CohortOption | null>(null);
  const [cohorts, setCohorts] = useState<CohortOption[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [hasCompany, setHasCompany] = useState(false);
  const [generationJob, setGenerationJob] = useState<GenerationJobStatus | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const generationWasActive = useRef(false);
  const refreshedSettledJobId = useRef<string | null>(null);
  const initialRefetchStarted = useRef(false);

  const refetch = useCallback(async (options?: { syncPoints?: boolean }) => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setIsLoading(false);
      return;
    }

    // Round 1: everything below only needs the user's own id, so it's fired as one
    // batch instead of four sequential round-trips. self_onboarding_completed_at
    // stays a separate, best-effort query — it's a newer column (migration 021),
    // kept isolated so a not-yet-migrated DB doesn't break the core profile fetch.
    const [profResult, onboardingResult, cohortContext, archivedPlanResult] = await Promise.all([
      supabase
        .from("profiles")
        .select("full_name, total_points, weekly_goal, league_index, streak, company_id")
        .eq("id", user.id)
        .single(),
      supabase
        .from("profiles")
        .select("self_onboarding_completed_at")
        .eq("id", user.id)
        .maybeSingle(),
      fetch("/api/cohort-context", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      }).then((res) => res.json() as Promise<{
        cohorts?: CohortOption[];
        selectedCohortId?: string | null;
        currentCohortId?: string | null;
        error?: string;
      }>),
      supabase
        .from("personal_action_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .not("archived_at", "is", null),
    ]);

    const prof = profResult.data;
    if (prof) {
      setProfile({
        name: prof.full_name?.trim() || user.email?.split("@")[0] || "User",
        importanceRating: (prof as any).league_index ?? 0,
        weeklyGoal: prof.weekly_goal ?? 3,
        totalPoints: 0,
        onboarded: true,
        streak: prof.streak ?? 0,
      });
    }
    setSelfOnboardingCompletedAt((onboardingResult.data as any)?.self_onboarding_completed_at ?? null);

    const availableCohorts = cohortContext.cohorts ?? [];
    const selectedCohort = availableCohorts.find((item) => item.isSelected) ?? null;
    const selectedCohortId = selectedCohort?.id ?? null;
    setCohorts(availableCohorts);
    setCohort(selectedCohort);

    setHasArchivedPlans((archivedPlanResult.count ?? 0) > 0);

    const companyId = adminCompanyId ?? prof?.company_id;
    setHasCompany(!!companyId);

    // Round 2: everything below is cohort-scoped, so it can only start once
    // selectedCohortId (from round 1) is known — but within that constraint, all
    // five queries are independent of each other and run together.
    const [pointAccountResult, planSubscriptionResult, actionsResult, uasResult, eventsResult] = await Promise.all([
      selectedCohortId
        ? supabase
            .from("cohort_point_accounts")
            .select("current_points")
            .eq("user_id", user.id)
            .eq("cohort_id", selectedCohortId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Plan activation is cohort-specific. A previous finalised plan can be
      // archived while the newly assigned current cohort starts with no plan.
      selectedCohortId
        ? supabase
            .from("personal_action_subscriptions")
            .select("is_active, archived_at")
            .eq("user_id", user.id)
            .eq("cohort_id", selectedCohortId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      companyId && selectedCohortId
        ? Promise.all([
            supabase
              .from("actions")
              .select("id, cohort_id, plan_order, theme, title, how, why, time_estimate, is_personal, image_url, category")
              .eq("company_id", companyId)
              .eq("cohort_id", selectedCohortId)
              .order("plan_order", { ascending: true, nullsFirst: false })
              .order("created_at", { ascending: true }),
            supabase
              .from("personal_action_point_allocations")
              .select("action_id, points")
              .eq("user_id", user.id)
              .eq("cohort_id", selectedCohortId),
          ])
        : Promise.resolve(null),
      selectedCohortId
        ? supabase
            .from("user_actions")
            .select("*")
            .eq("user_id", user.id)
            .eq("cohort_id", selectedCohortId)
        : Promise.resolve({ data: [] }),
      selectedCohortId
        ? supabase
            .from("feed_events")
            .select("id, cohort_id, user_id, action_title, type, likes, created_at")
            .eq("user_id", user.id)
            .eq("cohort_id", selectedCohortId)
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] }),
    ]);

    const pointAccount = pointAccountResult.data;
    setProfile((current) => ({
      ...current,
      totalPoints: pointAccount?.current_points ?? (selectedCohortId ? 1000 : 0),
    }));

    const planSubscription = planSubscriptionResult.data;
    setPersonalPlanState(
      !planSubscription
        ? "none"
        : planSubscription.archived_at
          ? "archived"
          : planSubscription.is_active === true
            ? "active"
            : "draft"
    );

    if (actionsResult) {
      const [{ data: actions }, { data: allocations }] = actionsResult;
      const pointsByAction = new Map((allocations ?? []).map((row) => [row.action_id, row.points]));
      setAllActions((actions ?? []).map((row) => mapDbAction({
        ...row,
        plan_points: pointsByAction.get(row.id) ?? null,
      })));
    } else {
      setAllActions([]);
    }

    setUserActions((uasResult.data ?? []).map(mapDbUserAction));

    const displayName = prof?.full_name?.trim() || user.email?.split("@")[0] || "User";
    const items = (eventsResult.data ?? []).map((e) => {
      const it = mapDbFeedEvent(e);
      it.userName = it.userId === user.id ? displayName : "User";
      return it;
    });
    setFeed(items);
  }, [adminCompanyId]);

  useEffect(() => {
    if (initialRefetchStarted.current) return;
    initialRefetchStarted.current = true;
    refetch().finally(() => setIsLoading(false));
  }, [refetch, adminCompanyId]);

  const refreshGenerationStatus = useCallback(async (options?: { refreshActions?: boolean }) => {
    // Pass the cohort this render already resolved, so the poll (fired every
    // 3-12s for as long as the page is open) doesn't re-derive it from scratch
    // on every single call.
    const query = cohort?.id ? `?cohortId=${encodeURIComponent(cohort.id)}` : "";
    const response = await fetch(`/api/generation-status${query}`, {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Could not check action generation");

    const { job } = await response.json() as { job: GenerationJobStatus | null };
    const isGenerating = job?.status === "generating";
    const wasGenerating = generationWasActive.current;

    setGenerationJob(isGenerating ? job : null);
    setGenerationError(job?.status === "failed"
      ? job.errorMessage ?? "AI could not finish generating your actions. Please try again."
      : null);

    if (isGenerating) {
      generationWasActive.current = true;
      if (refreshedSettledJobId.current === job.id) refreshedSettledJobId.current = null;
    } else {
      generationWasActive.current = false;
    }

    const newlySettled = !!job
      && job.status !== "generating"
      && refreshedSettledJobId.current !== job.id;
    if (newlySettled) refreshedSettledJobId.current = job.id;

    if (options?.refreshActions !== false && (isGenerating || wasGenerating || newlySettled)) {
      await refetch({ syncPoints: false });
    }
    return job;
  }, [refetch, cohort?.id]);

  // Poll for background action-plan generation progress and re-pull actions as
  // they arrive. A completed job is refreshed once even when it finishes before
  // the first poll, so a fast generation cannot leave the page stale.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const job = await refreshGenerationStatus({ refreshActions: true });
        if (cancelled) return;
        const isGenerating = job?.status === "generating";
        if (!cancelled) timer = setTimeout(poll, isGenerating ? 3000 : 12000);
      } catch (error) {
        if (!cancelled) timer = setTimeout(poll, 12000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshGenerationStatus, generationJob?.id]);

  const updatePoints = async () => { };
  const addFeedItem = async () => { };
  const completeOnboarding = async () => { };
  const likeFeedItem = async () => { };
  const addNewAction = async (_action: Omit<import("./types").ActionCard, "id">) => {
    // Implemented in AdminDashboard via createAction server action
  };

  const completeAction = async (actionId: string, success: boolean, reflection?: string, options?: { waitForRefresh?: boolean }) => {
    const result = await completeActionServer({ actionId, success, reflection });
    if (!result.error) {
      if (options?.waitForRefresh === false) void refetch();
      else await refetch();
    }
    return result;
  };

  const declineAction = async (actionId: string) => {
    const { error } = await declineActionServer(actionId);
    if (!error) await refetch();
  };

  const dismissPendingValidation = async (actionId: string) => {
    const result = await dismissPendingValidationServer(actionId);
    if (!result.error) await refetch();
    return result;
  };

  const retryAction = async () => { };

  const validateAction = async (userActionId: string, success: boolean, reflection?: string) => {
    const { error } = await validateActionServer(userActionId, success, reflection);
    if (!error) await refetch();
  };

  const value = useMemo(
    () => ({
      profile,
      userActions,
      allActions,
      selfOnboardingCompletedAt,
      personalPlanState,
      hasArchivedPlans,
      cohort,
      cohorts,
      feed,
      isLoading,
      hasCompany,
      generationJob,
      generationError,
      refreshGenerationStatus,
      refetch,
      completeOnboarding,
      updatePoints,
      completeAction,
      declineAction,
      dismissPendingValidation,
      retryAction,
      validateAction,
      addFeedItem,
      likeFeedItem,
      addNewAction,
    }),
    [profile, userActions, allActions, selfOnboardingCompletedAt, personalPlanState, hasArchivedPlans, cohort, cohorts, feed, isLoading, hasCompany, generationJob, generationError, refetch, refreshGenerationStatus]
  );

  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
};

export const useEngine = () => {
  const context = useContext(EngineContext);
  if (!context) throw new Error("useEngine must be used within EngineProvider");
  return context;
};
