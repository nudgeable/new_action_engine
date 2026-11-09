/**
 * WhatsApp Cloud API sender. Server-only.
 *
 * Needs WHATSAPP_ACCESS_TOKEN (a system user token with
 * whatsapp_business_messaging) and WHATSAPP_PHONE_NUMBER_ID (the business
 * number's id). Until both are set, isWhatsAppSendConfigured() is false and
 * callers skip sending — the same degrade-gracefully pattern as
 * isResendConfigured().
 *
 * Every accepted send is recorded in whatsapp_message_logs so the webhook's
 * status updates (sent / delivered / read / failed) attach to it.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { TemplateComponent } from "@/lib/whatsapp-templates";

const GRAPH_API_VERSION = "v23.0";

export function isWhatsAppSendConfigured(): boolean {
  return !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID;
}

export type WhatsAppSendResult = { ok: true; wamid: string } | { ok: false; error: string };

/**
 * Free-form text. Only delivered if the recipient messaged the business in
 * the last 24 hours — use it for replies, not for reminders.
 */
export async function sendWhatsAppText(params: {
  to: string;
  body: string;
  userId?: string | null;
  purpose: string;
}): Promise<WhatsAppSendResult> {
  const to = params.to.replace(/\D/g, "");
  const result = await postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: params.body },
  });
  if (!result.ok) return result;
  await recordAcceptedMessage({ wamid: result.wamid, to, userId: params.userId ?? null, purpose: params.purpose });
  return result;
}

/**
 * Free-form interactive message (reply buttons or a list) — the same 24-hour
 * rule as sendWhatsAppText. `interactive` is the Cloud API object, e.g. from
 * buildCompletionFollowUp() in lib/whatsapp-action-completion.ts.
 */
export async function sendWhatsAppInteractive(params: {
  to: string;
  interactive: Record<string, unknown>;
  userId?: string | null;
  purpose: string;
}): Promise<WhatsAppSendResult> {
  const to = params.to.replace(/\D/g, "");
  const result = await postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: params.interactive,
  });
  if (!result.ok) return result;
  await recordAcceptedMessage({ wamid: result.wamid, to, userId: params.userId ?? null, purpose: params.purpose });
  return result;
}

/**
 * An approved template — the only kind of message that reaches someone
 * outside the 24-hour window, so every reminder goes through this.
 */
export async function sendWhatsAppTemplate(params: {
  to: string;
  template: { name: string; language: string };
  components: TemplateComponent[];
  userId?: string | null;
  purpose: string;
  /** Actions this message lists, so its read receipt can be tied to each one. */
  actionIds?: string[];
}): Promise<WhatsAppSendResult> {
  const to = params.to.replace(/\D/g, "");
  const result = await postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: params.template.name,
      language: { code: params.template.language },
      components: params.components,
    },
  });
  if (!result.ok) return result;
  await recordAcceptedMessage({
    wamid: result.wamid,
    to,
    userId: params.userId ?? null,
    purpose: params.purpose,
    templateName: params.template.name,
    actionIds: params.actionIds,
  });
  return result;
}

async function postMessage(payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
  if (!isWhatsAppSendConfigured()) return { ok: false, error: "WhatsApp sending is not configured" };

  let response: Response;
  try {
    response = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network error" };
  }

  const json = (await response.json().catch(() => null)) as
    | { messages?: { id?: string }[]; error?: { message?: string; code?: number } }
    | null;
  const wamid = json?.messages?.[0]?.id;
  if (!response.ok || !wamid) {
    const detail = json?.error ? `${json.error.code ?? response.status}: ${json.error.message}` : `HTTP ${response.status}`;
    return { ok: false, error: detail };
  }
  return { ok: true, wamid };
}

/**
 * The webhook can record a status for this wamid before we get here, so
 * insert-if-missing first, then attach who/why without touching the status.
 */
async function recordAcceptedMessage(params: {
  wamid: string;
  to: string;
  userId: string | null;
  purpose: string;
  templateName?: string;
  actionIds?: string[];
}) {
  const admin = createAdminClient();
  const { error: insertError } = await admin
    .from("whatsapp_message_logs")
    .upsert({ wamid: params.wamid, to_phone: params.to, status: "accepted" }, { onConflict: "wamid", ignoreDuplicates: true });
  const { error: updateError } = await admin
    .from("whatsapp_message_logs")
    .update({
      user_id: params.userId,
      purpose: params.purpose,
      template_name: params.templateName ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("wamid", params.wamid);
  if (insertError || updateError) {
    console.error("[whatsapp] failed to log accepted message", {
      wamid: params.wamid,
      error: insertError?.message ?? updateError?.message,
    });
  }
  // Separate write so a missing action_ids column (migration 087 not applied yet)
  // can't stop the who/why above from being recorded.
  if (params.actionIds?.length) {
    const { error: actionIdsError } = await admin
      .from("whatsapp_message_logs")
      .update({ action_ids: params.actionIds })
      .eq("wamid", params.wamid);
    if (actionIdsError) {
      console.error("[whatsapp] failed to record listed actions", { wamid: params.wamid, error: actionIdsError.message });
    }
  }
}
