"use server";

/**
 * One-off "Nudge" emails an admin sends a participant from the Dashboard
 * leaderboard. The email goes out through Resend on the platform's verified
 * sending address (RESEND_FROM_EMAIL), but carries the signed-in admin's name
 * as the sender name and their login email as Reply-To, so participants see
 * who nudged them and their replies land in that admin's inbox.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { isResendConfigured, resend } from "@/lib/resend";
import { buildFromHeader } from "@/lib/email-send";
import { getAdminContext } from "./admin-analytics";

const NUDGE_TEMPLATE_ID = "admin_nudge";
const MAX_SUBJECT_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;

export interface NudgeSender {
  name: string;
  email: string;
}

/** Who the nudge will come from: the signed-in admin. */
async function loadSender(): Promise<NudgeSender & { userId: string; companyId: string | null; role: string }> {
  const { supabase, companyId, role } = await getAdminContext();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) throw new Error("Your admin account has no email address");
  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user.id).single();
  const name = (profile?.full_name as string | null)?.trim() || user.email.split("@")[0];
  return { userId: user.id, email: user.email, name, companyId, role };
}

export async function getNudgeSender(): Promise<{ sender?: NudgeSender; error?: string }> {
  try {
    const { name, email } = await loadSender();
    return { sender: { name, email } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't load your admin details" };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deliberately plain, like an email typed in Gmail: no logo, banner, button or
 * footer, just the admin's paragraphs in the client's default-looking font.
 * It stays HTML (not text-only) so Resend can add its open-tracking pixel. */
function renderNudgeHtml(message: string): string {
  const paragraphs = message
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 1em;">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">\n${paragraphs}\n</div>`;
}

export async function sendParticipantNudge(input: {
  companyId: string | null;
  participantId: string;
  subject: string;
  message: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const subject = input.subject.trim();
    const message = input.message.trim();
    if (!subject) return { success: false, error: "Add a subject" };
    if (!message) return { success: false, error: "Write a message" };
    if (subject.length > MAX_SUBJECT_LENGTH) return { success: false, error: "Subject is too long" };
    if (message.length > MAX_MESSAGE_LENGTH) return { success: false, error: "Message is too long" };

    const sender = await loadSender();
    // Admins are pinned to their own company; superadmins act on the one they picked.
    const companyId = sender.role === "admin" ? sender.companyId : input.companyId;
    if (!companyId) return { success: false, error: "Company required" };

    if (!isResendConfigured()) {
      return { success: false, error: "Email isn't configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL." };
    }

    const admin = createAdminClient();
    const { data: participant } = await admin
      .from("profiles")
      .select("id, email, company_id, role")
      .eq("id", input.participantId)
      .single();
    if (!participant || participant.company_id !== companyId || participant.role !== "user") {
      return { success: false, error: "That participant isn't in this company" };
    }

    let toEmail = (participant.email as string | null)?.trim() || "";
    if (!toEmail) {
      const { data } = await admin.auth.admin.getUserById(participant.id);
      toEmail = data?.user?.email ?? "";
    }
    if (!toEmail) return { success: false, error: "This participant has no email address" };

    const { data: membership } = await admin
      .from("cohort_members")
      .select("cohort_id")
      .eq("user_id", participant.id)
      .limit(1)
      .maybeSingle();
    const cohortId = (membership?.cohort_id as string | undefined) ?? null;

    const { data: sendData, error: sendError } = await resend.emails.send({
      to: toEmail,
      from: buildFromHeader(process.env.RESEND_FROM_EMAIL!, sender.name),
      replyTo: sender.email,
      subject,
      html: renderNudgeHtml(message),
      text: message,
    });

    await admin.from("email_campaign_logs").insert({
      user_id: participant.id,
      email: toEmail,
      template_id: NUDGE_TEMPLATE_ID,
      status: sendError ? "failed" : "sent",
      error_message: sendError?.message ?? null,
      sent_by: sender.userId,
      resend_message_id: sendData?.id ?? null,
      cohort_id: cohortId,
    });

    if (sendError) return { success: false, error: sendError.message };
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Couldn't send the nudge" };
  }
}
