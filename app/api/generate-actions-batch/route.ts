import { NextResponse, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateDraftActions, draftsToActionRows, assignScheduledBatch, getPinnedFirstActionTitle } from "@/lib/personal-action-generation";
import { matchActionImagesForRows } from "@/lib/action-image-matching";
import { parseActionCategories } from "@/lib/action-categories";

/**
 * Background worker for filling a user's full multi-week action plan.
 * Generates one batch via Gemini and inserts it straight into the `actions`
 * table (is_personal = true) so it shows up in the Full Action Library
 * immediately, then re-triggers itself for the next batch until the job's
 * total_needed is reached. Runs as a chain of short-lived requests instead of
 * one long call so it isn't bound by a single serverless function's time limit.
 *
 * Auth: same optional Authorization: Bearer <CRON_SECRET> pattern as
 * app/api/cron/email-scheduler/route.ts, since this route is only ever
 * triggered server-to-server (never directly by a browser).
 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const authHeader = request.headers.get("authorization");
    const bearerToken = authHeader?.replace("Bearer ", "");
    if (bearerToken !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let jobId: string | undefined;
  try {
    const body = await request.json();
    jobId = body?.jobId;
  } catch {
    // ignore
  }
  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: job } = await admin
    .from("personal_action_generation_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (!job || job.status !== "generating") {
    return NextResponse.json({ ok: true, skipped: true });
  }
  if (!job.cohort_id) {
    await admin
      .from("personal_action_generation_jobs")
      .update({ status: "failed", error_message: "Generation job has no batch", updated_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: "Generation job has no batch" });
  }

  const remaining = job.total_needed - job.total_generated;
  const count = Math.min(job.batch_size ?? 12, remaining);
  const nowIso = new Date().toISOString();

  if (count <= 0) {
    await admin
      .from("personal_action_generation_jobs")
      .update({ status: "completed", updated_at: nowIso })
      .eq("id", jobId);
    return NextResponse.json({ ok: true, done: true });
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", job.user_id)
    .single();
  const companyId = profile?.company_id;
  if (!companyId) {
    await admin
      .from("personal_action_generation_jobs")
      .update({ status: "failed", error_message: "User has no company", updated_at: nowIso })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: "User has no company" });
  }

  // Only the very first batch of a plan supplies the plan's first action, so
  // only look up a pinned opener (and only bother with the extra query) then.
  let pinnedFirstAction: string | null = null;
  if (job.total_generated === 0) {
    const { data: company } = await admin
      .from("companies")
      .select("name")
      .eq("id", companyId)
      .single();
    pinnedFirstAction = getPinnedFirstActionTitle(company?.name);
  }

  // Recent titles for this user, to steer Gemini away from repeats across many batches.
  const { data: recentActions } = await admin
    .from("actions")
    .select("title")
    .eq("created_by", job.user_id)
    .eq("is_personal", true)
    .eq("cohort_id", job.cohort_id)
    .order("created_at", { ascending: false })
    .limit(30);
  // Once the pinned opener is inserted (below), it shows up here naturally on
  // every later batch's recentActions query — no need to add it separately.
  const avoidTitles = (recentActions ?? []).map((r) => r.title);

  const { data: cohortGenerationContext } = await admin
    .from("cohorts")
    .select("training_content, business_context, action_categories")
    .eq("id", job.cohort_id)
    .single();
  const categories = parseActionCategories(cohortGenerationContext?.action_categories);

  let generationResult = await generateDraftActions({
    trainingContent: cohortGenerationContext?.training_content ?? "",
    userNotes: job.training_text,
    businessContext: cohortGenerationContext?.business_context ?? "",
    focusThemes: job.focus_themes ?? [],
    count,
    avoidTitles,
    pinnedFirstAction: pinnedFirstAction ?? undefined,
    categories,
  });
  if (generationResult.error || !generationResult.drafts?.length) {
    // A temporary provider/network failure should not discard the participant's
    // whole plan. Retry this batch once before surfacing a failure.
    generationResult = await generateDraftActions({
      trainingContent: cohortGenerationContext?.training_content ?? "",
      userNotes: job.training_text,
      businessContext: cohortGenerationContext?.business_context ?? "",
      focusThemes: job.focus_themes ?? [],
      count,
      avoidTitles,
      pinnedFirstAction: pinnedFirstAction ?? undefined,
      categories,
    });
  }
  const { drafts, error } = generationResult;

  if (error || !drafts?.length) {
    await admin
      .from("personal_action_generation_jobs")
      .update({ status: "failed", error_message: error ?? "No drafts generated", updated_at: nowIso })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error });
  }

  // The participant may have changed the draft while this AI call was in
  // flight. Do not let a replaced job append stale actions afterward.
  const { data: latestJobState } = await admin
    .from("personal_action_generation_jobs")
    .select("status")
    .eq("id", jobId)
    .single();
  if (latestJobState?.status !== "generating") {
    return NextResponse.json({ ok: true, skipped: true, reason: "job_replaced" });
  }

  const rows = draftsToActionRows(drafts, companyId, job.user_id, job.cohort_id, job.total_generated);
  const { data: insertedActions, error: insertError } = await admin.from("actions").insert(rows).select("id, title, how, why");
  if (insertError) {
    await admin
      .from("personal_action_generation_jobs")
      .update({ status: "failed", error_message: insertError.message, updated_at: nowIso })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: insertError.message });
  }

  // Picking each action's thumbnail is a cheap best-effort step that must
  // never delay or fail this batch's response — run it after the response
  // goes out, same as the self-trigger for the next batch below.
  if (insertedActions?.length) {
    after(() => matchActionImagesForRows(admin, insertedActions));
  }

  const totalGenerated = job.total_generated + drafts.length;
  const isDone = totalGenerated >= job.total_needed;

  await admin
    .from("personal_action_generation_jobs")
    .update({
      total_generated: totalGenerated,
      status: isDone ? "completed" : "generating",
      updated_at: nowIso,
    })
    .eq("id", jobId);

  // If generation finishes after an active plan's first delivery became due,
  // fill that due batch here. Otherwise the daily/weekly cron owns delivery so
  // no action is released before tomorrow/the selected weekday.
  const { data: sub } = await admin
    .from("personal_action_subscriptions")
    .select("id, user_id, cohort_id, track, day_of_week, days_of_week, daily_action_count, time_of_day_utc, next_delivery_at, last_delivered_at, is_active, archived_at")
    .eq("user_id", job.user_id)
    .eq("cohort_id", job.cohort_id)
    .maybeSingle();
  if (
    sub
    && sub.is_active
    && !sub.archived_at
    && !sub.last_delivered_at
    && Date.parse(sub.next_delivery_at) <= Date.now()
  ) {
    await assignScheduledBatch(sub);
  }

  if (!isDone) {
    const origin = new URL(request.url).origin;
    after(async () => {
      try {
        const res = await fetch(`${origin}/api/generate-actions-batch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(expected ? { Authorization: `Bearer ${expected}` } : {}),
          },
          body: JSON.stringify({ jobId }),
        });
        const contentType = res.headers.get("content-type") ?? "";
        const payload = contentType.includes("application/json")
          ? await res.json() as { ok?: boolean; error?: string }
          : null;
        if (!res.ok || !payload || payload.ok !== true) {
          await admin
            .from("personal_action_generation_jobs")
            .update({
              status: "failed",
              error_message: payload?.error
                ?? (!contentType.includes("application/json")
                  ? "Next generation request returned an unexpected response"
                  : `Next batch trigger failed (HTTP ${res.status})`),
              updated_at: new Date().toISOString(),
            })
            .eq("id", jobId)
            .eq("status", "generating");
        }
      } catch (e) {
        await admin
          .from("personal_action_generation_jobs")
          .update({
            status: "failed",
            error_message: `Next batch trigger failed: ${e instanceof Error ? e.message : String(e)}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId)
          .eq("status", "generating");
      }
    });
  }

  return NextResponse.json({ ok: true, generated: drafts.length, totalGenerated, done: isDone });
}
