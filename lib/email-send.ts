/**
 * Shared utility for sending templated emails to a list of users.
 * Generates auto-login URLs, sends via Resend, and writes audit rows to
 * email_campaign_logs.  Used by both the manual campaign action and the
 * scheduled cron handler.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { resend } from "@/lib/resend";
import { isEmailTemplateKey, renderEmailTemplate, type EmailTemplateKey } from "@/lib/email-templates";
import { isBatchEmailSubjectKey, parseBatchEmailSubjects, type BatchEmailSubjects } from "@/lib/batch-email-subjects";
import { getAppUrl } from "@/lib/app-url";

/**
 * Builds a Resend "From" header showing a display name in front of the
 * verified sending address — e.g. `Gaurav <noreply@nudgeable.ai>`. Works
 * whether `fromEmailEnv` (RESEND_FROM_EMAIL) is a bare address or already
 * wrapped in a display name; either way, `displayName` wins.
 */
export function buildFromHeader(fromEmailEnv: string, displayName: string): string {
  const match = fromEmailEnv.match(/<([^>]+)>/);
  const address = (match ? match[1] : fromEmailEnv).trim();
  return `${displayName} <${address}>`;
}

export type SendToUsersResult = {
  userId: string;
  email: string;
  success: boolean;
  error?: string;
};

function isEmailDebugEnabled(): boolean {
  const v = (process.env.EMAIL_DEBUG_LOG ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function safeTemplateDataSummary(data: Record<string, unknown>) {
  const actions = Array.isArray((data as any).actions) ? ((data as any).actions as any[]) : [];
  const actionWhats = actions
    .map((a) => (a && typeof a === "object" ? (a as any).what : undefined))
    .filter((s) => typeof s === "string")
    .slice(0, 3) as string[];

  return {
    keys: Object.keys(data).sort(),
    actions_count: actions.length,
    actions_what_sample: actionWhats,
    rank: (data as any).rank,
    status: (data as any).status,
    league: (data as any).league,
    score: (data as any).score,
    first_name: (data as any).first_name,
    company_name: (data as any).company_name,
    // login_url may contain an auth key; don't print it.
    login_url_present: typeof (data as any).login_url === "string" && !!(data as any).login_url,
    has_login_email: typeof (data as any).login_email === "string",
    temporary_password_present:
      typeof (data as any).temporary_password === "string" &&
      !!(data as any).temporary_password,
  };
}

function readResendMessageId(sendData: unknown): string | null {
  if (!sendData || typeof sendData !== "object") return null;
  const record = sendData as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) return record.id;
  const nested = record.data;
  if (nested && typeof nested === "object") {
    const nestedId = (nested as Record<string, unknown>).id;
    if (typeof nestedId === "string" && nestedId) return nestedId;
  }
  return null;
}

export async function sendTemplateToUsers({
  userIds,
  templateId,
  fromEmail,
  baseUrl,
  sentBy,
  extraTemplateData = {},
  getPerUserTemplateData,
  includeStoredCredentials = false,
  loginPath,
  cohortIdForUser,
  cc,
  bcc,
}: {
  userIds: string[];
  /** Key of a template defined in lib/email-templates.ts (e.g. "weekly_challenges", "credentials"). */
  templateId: string;
  fromEmail: string;
  /** Ignored for links: emails always point at the production app (see normalizedBase). */
  baseUrl: string;
  sentBy: string | null;
  extraTemplateData?: Record<string, unknown>;
  getPerUserTemplateData?: (userId: string) => Promise<Record<string, unknown>>;
  /** When true, merges login_email, temporary_password, app_login_url from user_credential_delivery (row is not deleted). */
  includeStoredCredentials?: boolean;
  /** Optional safe in-app destination after auto-login, e.g. "/actions". */
  loginPath?: string;
  /** Prefer this batch over profiles.selected_cohort_id when logging the send. */
  cohortIdForUser?: (userId: string) => string | null | undefined;
  /** Copied on every recipient's email. Each copy is identical to that
   * recipient's email, including their personal auto-login link. */
  cc?: string[];
  bcc?: string[];
}): Promise<SendToUsersResult[]> {
  if (!isEmailTemplateKey(templateId)) {
    return userIds.map((userId) => ({
      userId,
      email: "",
      success: false,
      error: `Unknown email template "${templateId}"`,
    }));
  }
  const templateKey: EmailTemplateKey = templateId;

  const admin = createAdminClient();

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, persistent_login_key, full_name, selected_cohort_id, current_cohort_id")
    .in("id", userIds);

  const profileMap = new Map(
    (profiles ?? []).map((p: {
      id: string;
      persistent_login_key: string | null;
      full_name: string | null;
      selected_cohort_id: string | null;
      current_cohort_id: string | null;
    }) => [
      p.id,
      { key: p.persistent_login_key, fullName: p.full_name, cohortId: p.selected_cohort_id ?? p.current_cohort_id },
    ])
  );

  if (cohortIdForUser) {
    for (const userId of userIds) {
      const override = cohortIdForUser(userId);
      if (!override) continue;
      const existing = profileMap.get(userId);
      if (existing) existing.cohortId = override;
    }
  }

  // Each recipient's email shows their cohort's sender name: an explicit
  // per-batch override set in Cohort Management wins first, then the
  // cohort's assigned trainer, then "Nudgeable" when neither is set (or the
  // recipient has no cohort yet — e.g. a brand-new user's welcome email).
  const cohortIds = [...new Set(
    [...profileMap.values()].map((p) => p.cohortId).filter((id): id is string => !!id)
  )];
  const trainerIdByCohortId = new Map<string, string>();
  const senderNameByCohortId = new Map<string, string>();
  // Superadmin-set subject overrides per batch (lib/batch-email-subjects.ts).
  const emailSubjectsByCohortId = new Map<string, BatchEmailSubjects>();
  if (cohortIds.length) {
    const { data: cohortRows } = await admin
      .from("cohorts")
      .select("id, trainer_id, sender_name, email_subjects")
      .in("id", cohortIds);
    for (const row of cohortRows ?? []) {
      if (row.trainer_id) trainerIdByCohortId.set(row.id as string, row.trainer_id as string);
      if (row.sender_name) senderNameByCohortId.set(row.id as string, row.sender_name as string);
      emailSubjectsByCohortId.set(row.id as string, parseBatchEmailSubjects(row.email_subjects));
    }
  }
  const trainerNameById = new Map<string, string>();
  const trainerIds = [...new Set(trainerIdByCohortId.values())];
  if (trainerIds.length) {
    const { data: trainerRows } = await admin
      .from("trainers")
      .select("id, name")
      .in("id", trainerIds);
    for (const row of trainerRows ?? []) {
      if (row.name) trainerNameById.set(row.id as string, row.name as string);
    }
  }

  const credentialMap = new Map<string, { email: string; plaintext_password: string }>();
  if (includeStoredCredentials) {
    const { data: credRows } = await admin
      .from("user_credential_delivery")
      .select("user_id, email, plaintext_password")
      .in("user_id", userIds);
    for (const row of credRows ?? []) {
      credentialMap.set(row.user_id as string, {
        email: row.email as string,
        plaintext_password: row.plaintext_password as string,
      });
    }
  }

  // Supabase listUsers is paginated. Loading only the first page silently
  // skipped recipients in larger organisations, so keep paging until every
  // requested account has been resolved or there are no more auth users.
  const wantedUserIds = new Set(userIds);
  const userEmailMap = new Map<string, string | undefined>();
  const perPage = 1000;
  for (let page = 1; wantedUserIds.size > 0; page += 1) {
    const { data: usersData, error: usersError } = await admin.auth.admin.listUsers({ page, perPage });
    if (usersError) break;
    for (const authUser of usersData?.users ?? []) {
      if (!wantedUserIds.has(authUser.id)) continue;
      userEmailMap.set(authUser.id, authUser.email);
      wantedUserIds.delete(authUser.id);
    }
    if ((usersData?.users ?? []).length < perPage) break;
  }

  const results: SendToUsersResult[] = [];
  // Every email links to the production app. Senders still pass a baseUrl,
  // but it comes from NEXT_PUBLIC_APP_URL (the Vercel deployment URL) or the
  // request host (localhost), and participants must never land there. Only the
  // explicit NUDGEABLE_APP_URL test override changes it (see lib/app-url.ts).
  const normalizedBase = getAppUrl();
  const appLoginUrl = `${normalizedBase}/login`;

  for (const userId of userIds) {
    const email = userEmailMap.get(userId);
    const prof = profileMap.get(userId);
    const key = prof?.key ?? null;

    if (!email) {
      results.push({ userId, email: "", success: false, error: "User email not found" });
      continue;
    }
    if (!key) {
      results.push({ userId, email, success: false, error: "No login key (run migrations)" });
      continue;
    }

    if (includeStoredCredentials && !credentialMap.has(userId)) {
      results.push({
        userId,
        email,
        success: false,
        error: "No stored credentials for this user (create user from admin or re-save password)",
      });
      continue;
    }

    const requestedLoginPath = loginPath ?? (templateKey === "credentials" ? "/journey" : undefined);
    const safeLoginPath = requestedLoginPath?.startsWith("/") && !requestedLoginPath.startsWith("//")
      ? requestedLoginPath
      : undefined;
    const loginUrl = key
      ? `${normalizedBase}/api/auto-login?key=${encodeURIComponent(key)}${safeLoginPath ? `&next=${encodeURIComponent(safeLoginPath)}` : ""}`
      : appLoginUrl;
    const firstName =
      (prof?.fullName ?? "").trim().split(/\s+/)[0] ||
      email.split("@")[0] ||
      "there";

    try {
      const perUser = getPerUserTemplateData ? await getPerUserTemplateData(userId) : {};
      const cleanedExtra = omitUndefined(extraTemplateData);
      const cleanedPerUser = omitUndefined(perUser);
      const cred = includeStoredCredentials ? credentialMap.get(userId) : undefined;
      const dynamicTemplateData: Record<string, unknown> = {
        login_url: loginUrl,
        first_name: firstName,
        ...cleanedExtra,
        ...cleanedPerUser,
      };
      if (includeStoredCredentials && cred) {
        dynamicTemplateData.login_email = cred.email;
        dynamicTemplateData.temporary_password = cred.plaintext_password;
        dynamicTemplateData.app_login_url = appLoginUrl;
      }

      // Give the action reminder and Friday recap a per-action "Mark done" link: it reuses
      // the same auto-login key as the main CTA, but sends the participant
      // straight to /actions with ?completeAction=<id> so the app settles
      // that specific action and shows the usual celebration on arrival —
      // no extra tap needed once the email link is opened.
      if ((templateKey === "daily_reminder" || templateKey === "weekly_recap") && key && Array.isArray(dynamicTemplateData.actions)) {
        dynamicTemplateData.actions = (dynamicTemplateData.actions as Record<string, unknown>[]).map((action) => {
          const actionId = typeof action.id === "string" ? action.id : undefined;
          if (!actionId) return action;
          const completeNext = `/actions?completeAction=${encodeURIComponent(actionId)}`;
          return {
            ...action,
            complete_url: `${normalizedBase}/api/auto-login?key=${encodeURIComponent(key)}&next=${encodeURIComponent(completeNext)}`,
          };
        });
      }

      // The Friday week recap also gets one "Confirm all as completed"
      // button that bulk-completes every listed action in a single click,
      // via the same auto-login mechanism as the per-action Mark done link.
      if (templateKey === "weekly_recap" && key && Array.isArray(dynamicTemplateData.actions)) {
        const actionIds = (dynamicTemplateData.actions as Record<string, unknown>[])
          .map((action) => (typeof action.id === "string" ? action.id : undefined))
          .filter((id): id is string => Boolean(id));
        if (actionIds.length) {
          const completeAllNext = `/actions?completeActions=${encodeURIComponent(actionIds.join(","))}`;
          dynamicTemplateData.complete_all_url = `${normalizedBase}/api/auto-login?key=${encodeURIComponent(key)}&next=${encodeURIComponent(completeAllNext)}`;
        }
      }

      if (isEmailDebugEnabled()) {
        console.log("[email-send] sending template email", {
          userId,
          email,
          templateId,
          fromEmail,
          data: safeTemplateDataSummary(dynamicTemplateData),
        });
      }

      const cohortSenderName = prof?.cohortId ? senderNameByCohortId.get(prof.cohortId) : undefined;
      const trainerId = prof?.cohortId ? trainerIdByCohortId.get(prof.cohortId) : undefined;
      const senderName = cohortSenderName ?? (trainerId ? trainerNameById.get(trainerId) : undefined) ?? "Nudgeable";

      const batchSubject =
        prof?.cohortId && isBatchEmailSubjectKey(templateKey)
          ? emailSubjectsByCohortId.get(prof.cohortId)?.[templateKey]
          : undefined;
      if (batchSubject) dynamicTemplateData.batch_subject = batchSubject;

      const { subject, html } = renderEmailTemplate(templateKey, dynamicTemplateData);
      const { data: sendData, error: sendError } = await resend.emails.send({
        to: email,
        from: buildFromHeader(fromEmail, senderName),
        subject,
        html,
        ...(cc?.length ? { cc } : {}),
        ...(bcc?.length ? { bcc } : {}),
      });
      if (sendError) throw new Error(sendError.message);

      const resendMessageId = readResendMessageId(sendData);
      if (isEmailDebugEnabled() && !resendMessageId) {
        console.log("[email-send] Resend send succeeded but no message id on response", {
          userId,
          templateId,
          sendData,
        });
      }

      // Actions this email lists, so its open can be tied to each one (admin "Seen on").
      const listedActionIds =
        (templateKey === "daily_reminder" || templateKey === "weekly_recap") && Array.isArray(dynamicTemplateData.actions)
          ? (dynamicTemplateData.actions as Record<string, unknown>[])
              .map((action) => (typeof action.id === "string" ? action.id : undefined))
              .filter((id): id is string => Boolean(id))
          : [];
      const sentLog = {
        user_id: userId,
        email,
        template_id: templateId,
        status: "sent",
        sent_by: sentBy,
        resend_message_id: resendMessageId,
        cohort_id: prof?.cohortId ?? null,
      };
      let { error: logError } = await admin
        .from("email_campaign_logs")
        .insert(listedActionIds.length ? { ...sentLog, action_ids: listedActionIds } : sentLog);
      // If migration 087 (action_ids) isn't applied yet, still keep the send log.
      if (logError && listedActionIds.length) {
        ({ error: logError } = await admin.from("email_campaign_logs").insert(sentLog));
      }
      if (logError) {
        console.error("[email-send] failed to write campaign log", logError.message);
      }

      results.push({ userId, email, success: true });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Resend error";

      if (isEmailDebugEnabled()) {
        console.log("[email-send] failed sending template email", {
          userId,
          email,
          templateId,
          error: errorMessage,
        });
      }

      await admin.from("email_campaign_logs").insert({
        user_id: userId,
        email,
        template_id: templateId,
        status: "failed",
        error_message: errorMessage,
        sent_by: sentBy,
        cohort_id: prof?.cohortId ?? null,
      });

      results.push({ userId, email, success: false, error: errorMessage });
    }
  }

  return results;
}
