"use server";

import { revalidatePath, unstable_cache, updateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Cohort, CohortDate, CohortMember, CohortOption, CompanyBrand, ProgramPhase, Trainer } from "@/lib/types";
import { parseProgramPhasesJson } from "@/lib/program-phases";
import { parseBatchEmailSubjects, sanitizeBatchEmailSubjects } from "@/lib/batch-email-subjects";
import { parseActionCategories, sanitizeActionCategories } from "@/lib/action-categories";

const COHORT_LOGOS_BUCKET = "cohort-logos";

/** Legacy composite string kept in sync on `cohorts.name` for read sites that
 * only need a single display string (emails, the cohort switcher, etc.). */
function composeCohortName(batchName: string, moduleName?: string | null): string {
  const batch = batchName.trim();
  const module_ = moduleName?.trim();
  return module_ ? `${batch} — ${module_}` : batch;
}

// `profiles.email` is copied from `auth.users` and kept in sync by DB
// triggers (see migration 043_profiles_email.sql), so member emails can be
// read straight off the profiles join below — no need for the expensive
// admin.auth.admin.listUsers() call (which fetches up to 1000 users across
// the WHOLE project, not just this cohort/company) that used to run here.
function mapMemberRow(m: {
  user_id: string;
  profiles: { id: string; full_name: string | null; email: string | null } | { id: string; full_name: string | null; email: string | null }[] | null;
  participant_tags?: { id: string; name: string } | { id: string; name: string }[] | null;
}): CohortMember {
  const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
  const tagRow = Array.isArray(m.participant_tags) ? m.participant_tags[0] : m.participant_tags;
  return {
    id: m.user_id,
    fullName: profile?.full_name ?? null,
    email: profile?.email ?? null,
    tag: tagRow ? { id: tagRow.id, name: tagRow.name } : null,
  };
}

async function loadTrainerMap(
  supabase: Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createAdminClient>,
  trainerIds: (string | null)[],
): Promise<Map<string, Trainer>> {
  const ids = [...new Set(trainerIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const { data } = await supabase.from("trainers").select("id, name, image_url").in("id", ids);
  return new Map((data ?? []).map((row: { id: string; name: string; image_url: string | null }) => [
    row.id,
    { id: row.id, name: row.name, imageUrl: row.image_url },
  ]));
}

type CompanyBrandRow = { id: string; name: string; logo_url: string | null };

/** Company id/name/logo for a batch of companies. The program agenda lives on
 * the cohort itself now (cohorts.program_phases) — see migration
 * 070_cohort_program_phases.sql. */
async function loadCompanyBrandRows(
  supabase: Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createAdminClient>,
  companyIds: string[],
): Promise<CompanyBrandRow[]> {
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return [];

  const { data } = await supabase.from("companies").select("id, name, logo_url").in("id", ids);
  return (data ?? []) as CompanyBrandRow[];
}

/** Every cohort_dates row for a batch of cohorts, grouped and sorted ascending
 * per cohort — the shape Cohort.dates needs. */
async function loadCohortDatesMap(
  supabase: Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createAdminClient>,
  cohortIds: string[],
): Promise<Map<string, string[]>> {
  const ids = [...new Set(cohortIds)];
  if (ids.length === 0) return new Map();
  const { data } = await supabase
    .from("cohort_dates")
    .select("cohort_id, event_date")
    .in("cohort_id", ids)
    .order("event_date", { ascending: true });
  const map = new Map<string, string[]>();
  for (const row of (data ?? []) as { cohort_id: string; event_date: string }[]) {
    const list = map.get(row.cohort_id) ?? [];
    list.push(row.event_date);
    map.set(row.cohort_id, list);
  }
  return map;
}

async function getAdminContext(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
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
    userId: user.id,
    companyId: profile?.company_id ?? null,
    role,
  };
}

/** Plain 'user'-role accounts in a company, for the cohort member picker.
 * Uses the service-role client: profiles' RLS only lets a company admin read
 * rows in their OWN company, and a superadmin's own company_id is null, so a
 * superadmin browsing another company's users would be silently RLS-filtered
 * to zero rows via the regular client — authorization is already enforced by
 * getAdminContext() above, so bypassing RLS here is safe. */
export async function getCompanyUsers(companyId: string): Promise<
  { error?: string; users?: { id: string; full_name: string | null; email: string | null; current_cohort_id: string | null }[] }> {
  try {
    const { companyId: myCompanyId, role } = await getAdminContext();
    if (role === "admin" && myCompanyId !== companyId) return { error: "Access denied" };

    // profiles.email is synced from auth.users by a DB trigger (migration
    // 043_profiles_email.sql), so it can be selected directly — no need for
    // the admin.auth.admin.listUsers() full-project user scan this used to do.
    const admin = createAdminClient();
    const { data: profiles, error } = await admin
      .from("profiles")
      .select("id, full_name, email, current_cohort_id")
      .eq("company_id", companyId)
      .eq("role", "user");
    if (error) return { error: error.message };

    return {
      users: (profiles ?? []).map((p) => ({
        id: p.id,
        full_name: p.full_name,
        email: p.email ?? null,
        current_cohort_id: p.current_cohort_id ?? null,
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function createCohort(params: {
  batchName: string;
  moduleName?: string;
  description?: string;
  trainingContent?: string;
  businessContext?: string;
  /** Optional single date to seed cohort_dates with — more can be added afterwards. */
  initialDate?: string;
  companyId?: string;
  /** Email "From" display name override for this batch. Blank/omitted falls
   * back to the assigned trainer, then "Nudgeable" (see lib/email-send.ts). */
  senderName?: string;
  /** Cap (in weeks) on how long a participant's action plan for this batch
   * may run. Omitted/null leaves the global 2-24 week range in effect. */
  maxWeeks?: number | null;
}): Promise<{ error?: string; id?: string }> {
  try {
    const { supabase, userId, companyId, role } = await getAdminContext();
    const resolvedCompanyId = role === "admin" ? companyId : params.companyId;
    if (!resolvedCompanyId) return { error: "Company required" };

    if (params.maxWeeks != null && (!Number.isInteger(params.maxWeeks) || params.maxWeeks < 2 || params.maxWeeks > 24)) {
      return { error: "Maximum plan weeks must be between 2 and 24" };
    }

    const batchName = params.batchName.trim();
    const moduleName = params.moduleName?.trim() || null;

    const { data, error } = await supabase
      .from("cohorts")
      .insert({
        company_id: resolvedCompanyId,
        created_by: userId,
        batch_name: batchName,
        module_name: moduleName,
        name: composeCohortName(batchName, moduleName),
        description: params.description?.trim() || null,
        training_content: role === "superadmin" ? params.trainingContent?.trim() || null : null,
        business_context: role === "superadmin" ? params.businessContext?.trim() || null : null,
        sender_name: params.senderName?.trim() || null,
        max_weeks: params.maxWeeks ?? null,
      })
      .select("id")
      .single();

    if (error) return { error: error.message };

    if (params.initialDate) {
      await supabase.from("cohort_dates").insert({ cohort_id: data.id, event_date: params.initialDate, created_by: userId });
    }

    revalidatePath("/admin");
    return { id: data.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function updateCohort(
  id: string,
  params: {
    batchName?: string;
    moduleName?: string;
    description?: string;
    trainingContent?: string;
    businessContext?: string;
    logoUrl?: string | null;
    trainerId?: string | null;
    /** Email "From" display name override for this batch. An empty string
     * clears it back to the trainer/"Nudgeable" fallback chain. */
    senderName?: string;
    /** Program agenda JSON pasted in by an admin/superadmin. Undefined leaves
     * it unchanged; an empty string clears it. Parsed with parseProgramPhasesJson. */
    programPhasesJson?: string;
    /** The id of the phase this batch is currently in (or null to clear it). */
    currentPhaseId?: string | null;
    /** Cap (in weeks) on how long a participant's action plan for this batch
     * may run. Null clears it back to the global 2-24 week range. */
    maxWeeks?: number | null;
    /** Subject overrides keyed by email (daily_reminder, weekly_recap).
     * Replaces the stored set; blank entries fall back to the default.
     * Superadmin only. */
    emailSubjects?: Record<string, string | null | undefined>;
    /** Categories the AI tags this batch's generated actions with (max 5).
     * Replaces the stored list; an empty list turns categories off.
     * Superadmin only. */
    actionCategories?: string[];
  }
): Promise<{ error?: string }> {
  try {
    const { supabase, companyId, role } = await getAdminContext();

    if (role === "admin") {
      const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", id).single();
      if (!cohort || cohort.company_id !== companyId) return { error: "Batch not found or access denied" };
      if (params.trainingContent !== undefined || params.businessContext !== undefined) {
        return { error: "Only a superadmin can change action generation context" };
      }
      if (params.trainerId !== undefined) {
        return { error: "Only a superadmin can assign this batch's trainer" };
      }
      if (params.emailSubjects !== undefined) {
        return { error: "Only a superadmin can change this batch's email subjects" };
      }
      if (params.actionCategories !== undefined) {
        return { error: "Only a superadmin can change this batch's action categories" };
      }
    }

    const { phases, error: phasesError } = parseProgramPhasesJson(params.programPhasesJson);
    if (phasesError) return { error: phasesError };

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (phases !== undefined) updates.program_phases = phases;
    if (params.currentPhaseId !== undefined) updates.current_phase_id = params.currentPhaseId || null;
    if (params.batchName != null || params.moduleName !== undefined) {
      // Only one part may have been passed in — fetch the other so the
      // derived `name` composite (and the untouched part) stays correct.
      const { data: current } = await supabase.from("cohorts").select("batch_name, module_name").eq("id", id).single();
      const nextBatchName = params.batchName != null ? params.batchName.trim() : current?.batch_name ?? "";
      const nextModuleName = params.moduleName !== undefined ? params.moduleName.trim() || null : current?.module_name ?? null;
      updates.batch_name = nextBatchName;
      updates.module_name = nextModuleName;
      updates.name = composeCohortName(nextBatchName, nextModuleName);
    }
    if (params.description != null) updates.description = params.description.trim() || null;
    if (params.trainingContent != null) updates.training_content = params.trainingContent.trim() || null;
    if (params.businessContext != null) updates.business_context = params.businessContext.trim() || null;
    if (params.logoUrl !== undefined) updates.logo_url = params.logoUrl?.trim() || null;
    if (params.trainerId !== undefined) updates.trainer_id = params.trainerId || null;
    if (params.senderName !== undefined) updates.sender_name = params.senderName.trim() || null;
    if (params.maxWeeks !== undefined) {
      if (params.maxWeeks !== null && (!Number.isInteger(params.maxWeeks) || params.maxWeeks < 2 || params.maxWeeks > 24)) {
        return { error: "Maximum plan weeks must be between 2 and 24" };
      }
      updates.max_weeks = params.maxWeeks;
    }
    if (params.emailSubjects !== undefined) {
      const { subjects, error: subjectsError } = sanitizeBatchEmailSubjects(params.emailSubjects);
      if (subjectsError) return { error: subjectsError };
      updates.email_subjects = subjects;
    }
    if (params.actionCategories !== undefined) {
      const { categories, error: categoriesError } = sanitizeActionCategories(params.actionCategories);
      if (categoriesError) return { error: categoriesError };
      updates.action_categories = categories;
    }

    const { error } = await supabase.from("cohorts").update(updates).eq("id", id);
    if (error) return { error: error.message };
    // Participants read categories from the cached my-cohorts lookup (for the
    // edit popup's dropdown) — drop it so they see the new list right away.
    if (params.actionCategories !== undefined) updateTag("my-cohorts");
    revalidatePath("/admin");
    revalidatePath("/journey");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

/** Lock or unlock a cohort. While locked, participants lose access to My
 * Plan, action creation, and the Commitment Wallet (see cohortLockInfo() in
 * lib/cohort-lock.ts and the gate at the top of those three pages) — they
 * see a countdown to the cohort's next date instead. Superadmin only,
 * unlike the rest of updateCohort's fields which a company admin can touch. */
export async function setCohortLock(id: string, locked: boolean): Promise<{ error?: string }> {
  try {
    const { supabase, role } = await getAdminContext();
    if (role !== "superadmin") return { error: "Only a superadmin can lock or unlock a batch" };

    const { error } = await supabase
      .from("cohorts")
      .update({ locked, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { error: error.message };

    // Affects every member of the cohort, not just the caller — cheaper to
    // drop the whole cache than to look up and tag-bust each member.
    updateTag("my-cohorts");
    revalidatePath("/admin");
    revalidatePath("/journey");
    revalidatePath("/plan");
    revalidatePath("/actions");
    revalidatePath("/wallet");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

/** The full list of dates on one cohort, with ids so each can be removed
 * individually — used by the cohort management "manage dates" list. */
export async function listCohortDates(cohortId: string): Promise<{ error?: string; dates?: CohortDate[] }> {
  try {
    const { supabase, companyId, role } = await getAdminContext();
    if (role === "admin") {
      const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", cohortId).single();
      if (!cohort || cohort.company_id !== companyId) return { error: "Batch not found or access denied" };
    }

    const { data, error } = await supabase
      .from("cohort_dates")
      .select("id, event_date")
      .eq("cohort_id", cohortId)
      .order("event_date", { ascending: true });
    if (error) return { error: error.message };
    return { dates: (data ?? []).map((row: { id: string; event_date: string }) => ({ id: row.id, date: row.event_date })) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function addCohortDate(cohortId: string, date: string): Promise<{ error?: string; id?: string }> {
  try {
    const { supabase, userId, companyId, role } = await getAdminContext();
    if (role === "admin") {
      const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", cohortId).single();
      if (!cohort || cohort.company_id !== companyId) return { error: "Batch not found or access denied" };
    }
    if (!date) return { error: "Date is required" };

    const { data, error } = await supabase
      .from("cohort_dates")
      .insert({ cohort_id: cohortId, event_date: date, created_by: userId })
      .select("id")
      .single();
    if (error) return { error: error.message };

    revalidatePath("/admin");
    revalidatePath("/journey");
    return { id: data.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

/** Move one training date to a different day. cohort_dates has no UPDATE
 * policy (see 058_cohort_multiple_dates.sql), so this inserts the new day
 * and then deletes the old row — both of which the admin policies allow. */
export async function updateCohortDate(cohortId: string, dateId: string, date: string): Promise<{ error?: string }> {
  try {
    const { supabase, userId, companyId, role } = await getAdminContext();
    if (role === "admin") {
      const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", cohortId).single();
      if (!cohort || cohort.company_id !== companyId) return { error: "Batch not found or access denied" };
    }
    if (!date) return { error: "Date is required" };

    const { error: insertError } = await supabase
      .from("cohort_dates")
      .insert({ cohort_id: cohortId, event_date: date, created_by: userId });
    if (insertError) return { error: insertError.message };

    const { error: deleteError } = await supabase.from("cohort_dates").delete().eq("id", dateId).eq("cohort_id", cohortId);
    if (deleteError) return { error: deleteError.message };

    revalidatePath("/admin");
    revalidatePath("/journey");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function removeCohortDate(cohortId: string, dateId: string): Promise<{ error?: string }> {
  try {
    const { supabase, companyId, role } = await getAdminContext();
    if (role === "admin") {
      const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", cohortId).single();
      if (!cohort || cohort.company_id !== companyId) return { error: "Batch not found or access denied" };
    }

    const { error } = await supabase.from("cohort_dates").delete().eq("id", dateId).eq("cohort_id", cohortId);
    if (error) return { error: error.message };

    revalidatePath("/admin");
    revalidatePath("/journey");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function createSignedCohortLogoUploadUrl(
  cohortId: string,
  fileExtension: string
): Promise<{ error?: string; path?: string; token?: string; publicUrl?: string }> {
  try {
    const { companyId, role } = await getAdminContext();
    const admin = createAdminClient();
    const { data: cohort } = await admin.from("cohorts").select("id, company_id").eq("id", cohortId).single();
    if (!cohort) return { error: "Batch not found" };
    if (role === "admin" && cohort.company_id !== companyId) return { error: "Access denied" };

    const safeExt = fileExtension.replace(/[^a-zA-Z0-9]/g, "").slice(0, 5).toLowerCase() || "png";
    const path = `${cohortId}/${crypto.randomUUID()}.${safeExt}`;
    const { data, error } = await admin.storage.from(COHORT_LOGOS_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { error: error?.message ?? "Failed to prepare batch logo upload" };

    const { data: publicUrlData } = admin.storage.from(COHORT_LOGOS_BUCKET).getPublicUrl(path);
    return { path, token: data.token, publicUrl: publicUrlData.publicUrl };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to prepare batch logo upload" };
  }
}

export async function archiveCohort(id: string): Promise<{ error?: string }> {
  try {
    const { supabase, companyId, role } = await getAdminContext();

    if (role === "admin") {
      const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", id).single();
      if (!cohort || cohort.company_id !== companyId) return { error: "Batch not found or access denied" };
    }

    const { error } = await supabase
      .from("cohorts")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { error: error.message };
    revalidatePath("/admin");
    revalidatePath("/admin/control-panel/cohorts");
    revalidatePath("/superadmin/cohorts");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function deleteCohort(id: string): Promise<{ error?: string }> {
  try {
    const { supabase, companyId, role } = await getAdminContext();

    if (role === "admin") {
      const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", id).single();
      if (!cohort || cohort.company_id !== companyId) return { error: "Batch not found or access denied" };
    }

    const { error } = await supabase.from("cohorts").delete().eq("id", id);
    if (error) return { error: error.message };
    revalidatePath("/admin");
    revalidatePath("/admin/control-panel/cohorts");
    revalidatePath("/superadmin/cohorts");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function listCohorts(companyId: string): Promise<{
  error?: string;
  company?: CompanyBrand;
  cohorts?: (Cohort & { contentCount: number })[];
}> {
  try {
    const { supabase, companyId: myCompanyId, role } = await getAdminContext();
    if (role === "admin" && myCompanyId !== companyId) return { error: "Access denied" };

    const [{ data: company }, { data: cohorts }] = await Promise.all([
      supabase.from("companies").select("id, name, logo_url").eq("id", companyId).single(),
      supabase
        .from("cohorts")
        .select("id, name, batch_name, module_name, description, training_content, business_context, logo_url, trainer_id, sender_name, email_subjects, action_categories, locked, program_phases, current_phase_id, max_weeks")
        .eq("company_id", companyId)
        .is("archived_at", null)
        .order("created_at", { ascending: false }),
    ]);

    const companyBrand = company ? { id: company.id, name: company.name, logoUrl: company.logo_url } : undefined;
    if (!cohorts?.length) return { company: companyBrand, cohorts: [] };
    const cohortIds = cohorts.map((c: { id: string }) => c.id);

    const [{ data: members }, { data: contentAssignments }, trainerMap, datesMap] = await Promise.all([
      supabase.from("cohort_members").select("cohort_id").in("cohort_id", cohortIds),
      supabase.from("cohort_prepare_assignments").select("cohort_id").in("cohort_id", cohortIds),
      loadTrainerMap(supabase, cohorts.map((c: { trainer_id: string | null }) => c.trainer_id)),
      loadCohortDatesMap(supabase, cohortIds),
    ]);
    const memberCounts = new Map<string, number>();
    for (const m of (members ?? []) as { cohort_id: string }[]) {
      memberCounts.set(m.cohort_id, (memberCounts.get(m.cohort_id) ?? 0) + 1);
    }
    const contentCounts = new Map<string, number>();
    for (const a of (contentAssignments ?? []) as { cohort_id: string }[]) {
      contentCounts.set(a.cohort_id, (contentCounts.get(a.cohort_id) ?? 0) + 1);
    }

    return {
      company: companyBrand,
      cohorts: cohorts.map((c: { id: string; name: string; batch_name: string; module_name: string | null; description: string | null; training_content: string | null; business_context: string | null; logo_url: string | null; trainer_id: string | null; sender_name: string | null; email_subjects: unknown; action_categories: unknown; locked: boolean; program_phases: ProgramPhase[]; current_phase_id: string | null; max_weeks: number | null }) => ({
        id: c.id,
        name: c.name,
        batchName: c.batch_name,
        moduleName: c.module_name,
        description: c.description,
        trainingContent: c.training_content,
        businessContext: c.business_context,
        dates: datesMap.get(c.id) ?? [],
        logoUrl: c.logo_url,
        memberCount: memberCounts.get(c.id) ?? 0,
        contentCount: contentCounts.get(c.id) ?? 0,
        trainerId: c.trainer_id,
        trainer: c.trainer_id ? trainerMap.get(c.trainer_id) ?? null : null,
        senderName: c.sender_name,
        emailSubjects: parseBatchEmailSubjects(c.email_subjects),
        actionCategories: parseActionCategories(c.action_categories),
        locked: c.locked,
        programPhases: c.program_phases ?? [],
        currentPhaseId: c.current_phase_id,
        maxWeeks: c.max_weeks,
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function getCohortDetail(cohortId: string): Promise<{
  error?: string;
  cohort?: Cohort;
  members?: CohortMember[];
}> {
  try {
    const { supabase, companyId: myCompanyId, role } = await getAdminContext();

    const { data: cohort } = await supabase
      .from("cohorts")
      .select("id, name, batch_name, module_name, description, training_content, business_context, logo_url, company_id, trainer_id, sender_name, email_subjects, action_categories, locked, program_phases, current_phase_id, max_weeks")
      .eq("id", cohortId)
      .single();
    if (!cohort) return { error: "Batch not found" };
    if (role === "admin" && cohort.company_id !== myCompanyId) return { error: "Access denied" };

    // Admin client: same profiles-RLS gap as getCompanyUsers above — a superadmin
    // viewing another company's cohort would otherwise get every member's name
    // silently nulled out by RLS on the embedded profiles join.
    const admin = createAdminClient();
    const [{ data: members }, trainerMap, datesMap] = await Promise.all([
      admin
        .from("cohort_members")
        .select("user_id, profiles!cohort_members_user_id_fkey(id, full_name, email), participant_tags(id, name)")
        .eq("cohort_id", cohortId),
      loadTrainerMap(admin, [cohort.trainer_id]),
      loadCohortDatesMap(admin, [cohortId]),
    ]);

    return {
      cohort: {
        id: cohort.id,
        name: cohort.name,
        batchName: cohort.batch_name,
        moduleName: cohort.module_name,
        description: cohort.description,
        trainingContent: cohort.training_content,
        businessContext: cohort.business_context,
        dates: datesMap.get(cohortId) ?? [],
        logoUrl: cohort.logo_url,
        memberCount: members?.length ?? 0,
        trainerId: cohort.trainer_id,
        trainer: cohort.trainer_id ? trainerMap.get(cohort.trainer_id) ?? null : null,
        senderName: cohort.sender_name,
        emailSubjects: parseBatchEmailSubjects(cohort.email_subjects),
        actionCategories: parseActionCategories(cohort.action_categories),
        locked: cohort.locked,
        programPhases: cohort.program_phases ?? [],
        currentPhaseId: cohort.current_phase_id,
        maxWeeks: cohort.max_weeks,
      },
      members: (members ?? []).map(mapMemberRow),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function addMembersToCohort(cohortId: string, userIds: string[]): Promise<{ error?: string }> {
  try {
    const { supabase, companyId: myCompanyId, role } = await getAdminContext();

    const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", cohortId).single();
    if (!cohort) return { error: "Batch not found" };
    if (role === "admin" && cohort.company_id !== myCompanyId) return { error: "Access denied" };

    // Admin client: same profiles-RLS gap — otherwise a superadmin's own (null)
    // company_id never matches, every userId looks "invalid", and this fails.
    const admin = createAdminClient();
    const { data: companyUsers } = await admin
      .from("profiles")
      .select("id")
      .eq("company_id", cohort.company_id)
      .in("id", userIds);
    const validIds = new Set((companyUsers ?? []).map((u: { id: string }) => u.id));
    const invalid = userIds.filter((id) => !validIds.has(id));
    if (invalid.length) return { error: "Some users do not belong to this batch's company" };

    const {
      data: { user },
    } = await supabase.auth.getUser();

    for (const userId of userIds) {
      const { error } = await supabase
        .from("cohort_members")
        .upsert({ cohort_id: cohortId, user_id: userId, added_by: user?.id }, { onConflict: "cohort_id,user_id" });
      if (error) return { error: error.message };

      // Upsert does not fire the INSERT trigger when the membership already
      // exists. Explicitly make this the user's current cohort in both cases.
      await admin
        .from("profiles")
        .update({ current_cohort_id: cohortId, selected_cohort_id: cohortId })
        .eq("id", userId);
      await admin
        .from("personal_action_subscriptions")
        .update({ is_active: false, archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .is("archived_at", null)
        .or(`cohort_id.is.null,cohort_id.neq.${cohortId}`);
      await admin
        .from("personal_action_generation_jobs")
        .update({ status: "failed", error_message: "Archived when participant moved to another batch", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("status", "generating")
        .or(`cohort_id.is.null,cohort_id.neq.${cohortId}`);
    }

    updateTag("my-cohorts");
    revalidatePath("/admin");
    revalidatePath("/journey");
    revalidatePath("/plan");
    revalidatePath("/actions");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function removeMembersFromCohort(cohortId: string, userIds: string[]): Promise<{ error?: string }> {
  try {
    const { supabase, companyId: myCompanyId, role } = await getAdminContext();

    const { data: cohort } = await supabase.from("cohorts").select("company_id").eq("id", cohortId).single();
    if (!cohort) return { error: "Batch not found" };
    if (role === "admin" && cohort.company_id !== myCompanyId) return { error: "Access denied" };

    const { error } = await supabase
      .from("cohort_members")
      .delete()
      .eq("cohort_id", cohortId)
      .in("user_id", userIds);
    if (error) return { error: error.message };
    updateTag("my-cohorts");

    revalidatePath("/admin");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

type MyCohortsResult = {
  error?: string;
  cohorts: CohortOption[];
  selectedCohortId: string | null;
  currentCohortId: string | null;
  /** The caller's own profile role — used by getMyCohort() to scope the
   * cohort lock (see setCohortLock) to participants ("user") only, so an
   * admin/superadmin/trainer who happens to land on /plan, /actions, or
   * /wallet is never blocked by a cohort they merely manage. */
  role?: string;
};

/**
 * The expensive per-user half of getMyCohorts() — profile + membership +
 * cohort/trainer/date/company lookups (~6 Supabase round trips). Only ever
 * called with a userId that's already been through supabase.auth.getUser(),
 * so it's safe to run entirely on the admin client, which makes it cacheable:
 * unstable_cache forbids reading cookies (the request-scoped, RLS-bound
 * client can't be used in here) but has no problem with the service-role
 * client.
 *
 * Caching this closes the redundant-fetch gap where the same cohort data
 * was computed twice per page load: once server-side (getMyCohort() gating
 * a page like /actions before rendering it) and again moments later from
 * the client's own /api/cohort-context call on EngineProvider's mount
 * (lib/store.tsx). Both calls now land within the 20s window and the second
 * one is a cache hit instead of another ~6-query round trip.
 *
 * Kept fresh by updateTag("my-cohorts") at every mutation that changes
 * cohort selection/membership/lock (selectMyCohort, addMembersToCohort,
 * removeMembersFromCohort, setCohortLock); the 20s TTL is just the fallback
 * for anything that isn't explicitly busted.
 */
const computeMyCohorts = unstable_cache(
  async (userId: string): Promise<MyCohortsResult> => {
    const admin = createAdminClient();
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("role, company_id, current_cohort_id, selected_cohort_id")
      .eq("id", userId)
      .single();
    if (profileError) {
      return {
        error: profileError.message,
        cohorts: [],
        selectedCohortId: null,
        currentCohortId: null,
      };
    }
    if (!profile) return { error: "Profile not found", cohorts: [], selectedCohortId: null, currentCohortId: null };

    let orderedIds: string[] = [];

    if (profile.role === "user") {
      const { data: memberships } = await admin
        .from("cohort_members")
        .select("cohort_id, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      orderedIds = (memberships ?? []).map((membership) => membership.cohort_id);
    } else if (profile.role === "admin" && profile.company_id) {
      const { data: managed } = await admin
        .from("cohorts")
        .select("id")
        .eq("company_id", profile.company_id)
        .order("created_at", { ascending: false });
      orderedIds = (managed ?? []).map((cohort) => cohort.id);
    } else if (profile.role === "trainer") {
      const { data: trainerRow } = await admin.from("trainers").select("id").eq("user_id", userId).maybeSingle();
      if (trainerRow) {
        const { data: run } = await admin
          .from("cohorts")
          .select("id")
          .eq("trainer_id", trainerRow.id)
          .order("created_at", { ascending: false });
        orderedIds = (run ?? []).map((cohort) => cohort.id);
      }
    } else {
      const { data: managed } = await admin
        .from("cohorts")
        .select("id")
        .eq("created_by", userId)
        .order("created_at", { ascending: false });
      orderedIds = (managed ?? []).map((cohort) => cohort.id);
    }

    if (!orderedIds.length) {
      return { cohorts: [], selectedCohortId: null, currentCohortId: null, role: profile.role };
    }

    const [{ data: cohortRows }, { data: memberRows }] = await Promise.all([
      admin
        .from("cohorts")
        .select("id, name, batch_name, module_name, description, logo_url, company_id, archived_at, trainer_id, locked, program_phases, current_phase_id, max_weeks, action_categories")
        .in("id", orderedIds),
      admin
        .from("cohort_members")
        .select("cohort_id")
        .in("cohort_id", orderedIds),
    ]);

    const cohortById = new Map((cohortRows ?? []).map((cohort) => [cohort.id, cohort]));
    const companyIds = Array.from(new Set((cohortRows ?? []).map((cohort) => cohort.company_id)));
    // These three only depend on cohortRows above, not on each other — run together
    // instead of one after another.
    const [trainerMap, datesMap, companyRows] = await Promise.all([
      loadTrainerMap(admin, (cohortRows ?? []).map((cohort) => cohort.trainer_id)),
      loadCohortDatesMap(admin, (cohortRows ?? []).map((cohort) => cohort.id)),
      companyIds.length ? loadCompanyBrandRows(admin, companyIds) : Promise.resolve([] as CompanyBrandRow[]),
    ]);
    const companyById = new Map(companyRows.map((company) => [company.id, company]));
    const memberCounts = new Map<string, number>();
    for (const row of memberRows ?? []) {
      memberCounts.set(row.cohort_id, (memberCounts.get(row.cohort_id) ?? 0) + 1);
    }

    const accessibleIds = orderedIds.filter((id) => cohortById.has(id));
    const currentCohortId = accessibleIds.includes(profile.current_cohort_id)
      ? profile.current_cohort_id
      : accessibleIds[0] ?? null;
    const selectedCohortId = accessibleIds.includes(profile.selected_cohort_id)
      ? profile.selected_cohort_id
      : currentCohortId;

    // Self-heal an invalid selected_cohort_id. This only runs on a cache
    // miss (not every call), which is fine — it's a background correction,
    // not something callers depend on: the corrected id is already returned
    // below regardless of whether this write happens.
    if (selectedCohortId && selectedCohortId !== profile.selected_cohort_id) {
      await admin.from("profiles").update({ selected_cohort_id: selectedCohortId }).eq("id", userId);
    }

    const cohorts: CohortOption[] = accessibleIds.map((id) => {
      const row = cohortById.get(id)!;
      const company = companyById.get(row.company_id);
      return {
        id: row.id,
        name: row.name,
        batchName: row.batch_name,
        moduleName: row.module_name,
        description: row.description,
        dates: datesMap.get(row.id) ?? [],
        logoUrl: row.logo_url,
        memberCount: memberCounts.get(row.id) ?? 0,
        companyId: row.company_id,
        companyName: company?.name ?? null,
        companyLogoUrl: company?.logo_url ?? null,
        programPhases: row.program_phases ?? [],
        currentPhaseId: row.current_phase_id,
        archivedAt: row.archived_at,
        isCurrent: row.id === currentCohortId,
        isSelected: row.id === selectedCohortId,
        trainerId: row.trainer_id,
        trainer: row.trainer_id ? trainerMap.get(row.trainer_id) ?? null : null,
        locked: row.locked,
        maxWeeks: row.max_weeks,
        actionCategories: parseActionCategories(row.action_categories),
      };
    });

    return { cohorts, selectedCohortId, currentCohortId, role: profile.role };
  },
  ["my-cohorts"],
  { revalidate: 20, tags: ["my-cohorts"] },
);

/**
 * Every cohort the caller may view, plus the separate current/selected flags.
 * Participants retain old memberships for history; trainers can switch between
 * the cohorts they manage in their company.
 */
export async function getMyCohorts(): Promise<MyCohortsResult> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Not authenticated", cohorts: [], selectedCohortId: null, currentCohortId: null };

    return await computeMyCohorts(user.id);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to load batches",
      cohorts: [],
      selectedCohortId: null,
      currentCohortId: null,
    };
  }
}

/** Change only the viewing context. This never reactivates or archives a plan. */
export async function selectMyCohort(cohortId: string): Promise<{ error?: string }> {
  const context = await getMyCohorts();
  if (context.error) return { error: context.error };
  if (!context.cohorts.some((cohort) => cohort.id === cohortId)) return { error: "You do not have access to this batch" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };
  const { error } = await supabase.from("profiles").update({ selected_cohort_id: cohortId }).eq("id", user.id);
  if (error) return { error: error.message };

  updateTag("my-cohorts");
  revalidatePath("/journey");
  revalidatePath("/notes");
  revalidatePath("/plan");
  revalidatePath("/actions");
  revalidatePath("/wallet");
  revalidatePath("/progress");
  return {};
}

/**
 * Selected logged-in cohort (+ roster, for participant pages that show fellow
 * members). Pass { includeRoster: false } when the caller only needs the cohort
 * itself (e.g. a lock check) — the roster join is a real query of its own (see
 * below) and several callers were fetching and immediately discarding it.
 */
export async function getMyCohort(options?: { includeRoster?: boolean }): Promise<{
  error?: string;
  cohort?: (Cohort & { companyId: string }) | null;
  roster?: CohortMember[];
}> {
  try {
    const includeRoster = options?.includeRoster !== false;
    const context = await getMyCohorts();
    if (context.error) return { error: context.error };
    const selected = context.cohorts.find((cohort) => cohort.isSelected) ?? null;
    const cohortId = selected?.id ?? null;
    if (!cohortId) return { cohort: null, roster: [] };

    let roster: CohortMember[] = [];
    if (includeRoster) {
      // Admin client: a plain member's own cohort_members row satisfies RLS
      // (user_id = auth.uid()), but the embedded profiles join for their
      // *fellow* members isn't covered by any regular-user SELECT policy on
      // profiles — without this, "Learn alongside N colleagues" would only
      // ever resolve the current user's own name.
      const admin = createAdminClient();
      const [{ data: members }, { data: teamNameRows }] = await Promise.all([
        admin
          .from("cohort_members")
          .select("user_id, profiles!cohort_members_user_id_fkey(id, full_name, email), participant_tags(id, name)")
          .eq("cohort_id", cohortId),
        admin.from("cohort_team_names").select("tag_id, display_name").eq("cohort_id", cohortId),
      ]);
      // Per-batch team display-name overrides (cohort_team_names, migration
      // 078) — a participant should see the same renamed team label a
      // superadmin set for this batch, not just the tag's global name.
      const teamNameOverrides = new Map((teamNameRows ?? []).map((row) => [row.tag_id, row.display_name]));
      roster = (members ?? []).map((row) => {
        const member = mapMemberRow(row);
        if (member.tag && teamNameOverrides.has(member.tag.id)) {
          member.tag = { ...member.tag, name: teamNameOverrides.get(member.tag.id)! };
        }
        return member;
      });
    }

    return {
      cohort: {
        id: selected!.id,
        name: selected!.name,
        batchName: selected!.batchName,
        moduleName: selected!.moduleName,
        description: selected!.description,
        dates: selected!.dates,
        logoUrl: selected!.logoUrl,
        // getMyCohorts() already computed this from a lightweight id-only query —
        // only prefer the roster's own count when the roster was actually fetched.
        memberCount: includeRoster ? roster.length : selected!.memberCount,
        companyId: selected!.companyId,
        companyName: selected!.companyName,
        companyLogoUrl: selected!.companyLogoUrl,
        programPhases: selected!.programPhases,
        currentPhaseId: selected!.currentPhaseId,
        trainerId: selected!.trainerId,
        trainer: selected!.trainer,
        // The lock only ever applies to participants — an admin/superadmin/
        // trainer who lands on a participant page via a cohort they merely
        // manage should never be blocked by it.
        locked: context.role === "user" && selected!.locked,
        maxWeeks: selected!.maxWeeks,
        actionCategories: selected!.actionCategories ?? [],
      },
      roster,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}
