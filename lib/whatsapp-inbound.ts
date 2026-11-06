/**
 * Acts on a message a participant sent to the business number (called by
 * app/api/webhooks/whatsapp/route.ts for each newly received message):
 *   - a "Done" tap (on a reminder or a follow-up) → completes that action
 *     (lib/whatsapp-action-completion.ts) and replies with what's still open
 *   - "All done" on the Friday recap → completes every action in that recap;
 *     "Some done" → replies with the open actions and a Done button for each
 *   - STOP / UNSUBSCRIBE → opts the sender out of WhatsApp reminders on
 *     every plan (whatsapp_contacts.opted_out_at)
 *   - START → opts back in, and turns WhatsApp on for their unarchived plans
 * Anything else is just stored by the route. Confirmation replies are
 * free-form text (the participant has just messaged us, so the 24-hour window
 * is open) and are skipped when sending isn't configured.
 *
 * Throws on database errors so the route can let Meta retry.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { parseOptKeyword } from "@/lib/whatsapp-contacts";
import {
  buildCompletionFollowUp,
  buildRecapAllDoneFollowUp,
  buildRecapSomeDoneFollowUp,
  completeActionFromWhatsApp,
  loadReminderActionStates,
  parseDonePayload,
  parseRecapPayload,
  type DoneTap,
  type FollowUpMessage,
  type RecapTap,
  type WhatsAppCompletion,
} from "@/lib/whatsapp-action-completion";
import { isWhatsAppSendConfigured, sendWhatsAppInteractive, sendWhatsAppText } from "@/lib/whatsapp";
import type { WhatsAppInboundMessage } from "@/lib/whatsapp-webhook";

type AdminClient = ReturnType<typeof createAdminClient>;

const REPLIES = {
  stopped: "You've turned off Nudgeable reminders on WhatsApp. Reply START to turn them back on.",
  started: "WhatsApp reminders are back on ✅ Reply STOP anytime to turn them off.",
  notConnected:
    "This number isn't linked to a Nudgeable account yet. Ask your programme admin to add it, or add it in the app under My Actions → Plan overview.",
} as const;

export async function handleInboundMessage(admin: AdminClient, message: WhatsAppInboundMessage): Promise<void> {
  const doneTap = parseDonePayload(message.replyPayload);
  if (doneTap) {
    await handleDoneTap(admin, message, doneTap);
    return;
  }

  const recapTap = parseRecapPayload(message.replyPayload);
  if (recapTap) {
    await handleRecapTap(admin, message, recapTap);
    return;
  }

  const keyword = parseOptKeyword(message.textBody);
  if (!keyword) return;

  const { data: contact, error: contactError } = await admin
    .from("whatsapp_contacts")
    .select("user_id, opted_out_at")
    .eq("phone", message.fromPhone)
    .maybeSingle();
  if (contactError) throw new Error(`load contact: ${contactError.message}`);

  const now = new Date().toISOString();

  if (keyword === "stop") {
    // Nothing to opt out of for an unknown number; WhatsApp's own blocking
    // still works for them.
    if (!contact) return;
    if (!contact.opted_out_at) {
      const { error } = await admin
        .from("whatsapp_contacts")
        .update({ opted_out_at: now, profile_name: message.profileName, updated_at: now })
        .eq("user_id", contact.user_id);
      if (error) throw new Error(`opt out: ${error.message}`);
    }
    await sendReply(message.fromPhone, REPLIES.stopped, contact.user_id, "whatsapp_opt_out");
    return;
  }

  if (!contact) {
    await sendReply(message.fromPhone, REPLIES.notConnected, null, "whatsapp_opt_in");
    return;
  }

  const { error: contactUpdateError } = await admin
    .from("whatsapp_contacts")
    .update({ opted_out_at: null, profile_name: message.profileName, updated_at: now })
    .eq("user_id", contact.user_id);
  if (contactUpdateError) throw new Error(`opt in: ${contactUpdateError.message}`);

  // START is an explicit request for reminders, so it also re-enables plans
  // where WhatsApp was unticked or turned off.
  const { error: planError } = await admin
    .from("personal_action_subscriptions")
    .update({ whatsapp_reminders_enabled: true, whatsapp_opted_in_at: now })
    .eq("user_id", contact.user_id)
    .eq("whatsapp_reminders_enabled", false)
    .is("archived_at", null);
  if (planError) throw new Error(`enable plans: ${planError.message}`);

  await sendReply(message.fromPhone, REPLIES.started, contact.user_id, "whatsapp_opt_in");
}

/**
 * WhatsApp guarantees which number tapped the button, and the action is only
 * completed for the participant that number belongs to — the database
 * function refuses actions that aren't on their plan.
 */
async function handleDoneTap(admin: AdminClient, message: WhatsAppInboundMessage, tap: DoneTap) {
  const userId = await tapUserId(admin, message);
  if (!userId) return;

  const completion = await completeActionFromWhatsApp(admin, userId, tap.actionId);
  // Best effort from here: the action is saved, so a failed follow-up must
  // not make Meta retry the tap.
  try {
    const actions = await loadReminderActionStates(admin, userId, tap.reminderActionIds);
    await sendFollowUp(message.fromPhone, buildCompletionFollowUp({ completion, tappedNumber: tap.number, actions }), userId);
  } catch (followUpError) {
    console.error("[whatsapp-inbound] follow-up failed", followUpError);
  }
}

/**
 * "All done" completes the recap's actions one at a time: profile points are
 * read then written, so parallel completions could lose some. If one throws,
 * Meta's retry runs the tap again and the finished ones come back as
 * already_done.
 */
async function handleRecapTap(admin: AdminClient, message: WhatsAppInboundMessage, tap: RecapTap) {
  const userId = await tapUserId(admin, message);
  if (!userId) return;

  const completions: WhatsAppCompletion[] = [];
  if (tap.kind === "all") {
    for (const actionId of tap.actionIds) completions.push(await completeActionFromWhatsApp(admin, userId, actionId));
  }

  // Best effort from here, as in handleDoneTap.
  try {
    const followUp =
      tap.kind === "all"
        ? buildRecapAllDoneFollowUp(completions)
        : buildRecapSomeDoneFollowUp(await loadReminderActionStates(admin, userId, tap.actionIds));
    await sendFollowUp(message.fromPhone, followUp, userId);
  } catch (followUpError) {
    console.error("[whatsapp-inbound] follow-up failed", followUpError);
  }
}

/** The participant behind a tap, or null after telling an unknown number so. */
async function tapUserId(admin: AdminClient, message: WhatsAppInboundMessage): Promise<string | null> {
  const { data: contact, error } = await admin
    .from("whatsapp_contacts")
    .select("user_id")
    .eq("phone", message.fromPhone)
    .maybeSingle();
  if (error) throw new Error(`load contact: ${error.message}`);
  if (!contact) {
    await sendReply(message.fromPhone, REPLIES.notConnected, null, "whatsapp_action_done");
    return null;
  }
  return contact.user_id as string;
}

async function sendFollowUp(to: string, followUp: FollowUpMessage, userId: string) {
  if (!isWhatsAppSendConfigured()) {
    console.warn("[whatsapp-inbound] action saved but no reply sent: WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set");
    return;
  }
  const result =
    followUp.kind === "text"
      ? await sendWhatsAppText({ to, body: followUp.body, userId, purpose: "whatsapp_action_done" })
      : await sendWhatsAppInteractive({ to, interactive: followUp.interactive, userId, purpose: "whatsapp_action_done" });
  if (!result.ok) console.error("[whatsapp-inbound] follow-up failed", { error: result.error });
}

/** Best-effort confirmation; a failed reply never fails the webhook. */
async function sendReply(to: string, body: string, userId: string | null, purpose: string) {
  if (!isWhatsAppSendConfigured()) {
    console.warn("[whatsapp-inbound] reply skipped: WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set", { purpose });
    return;
  }
  const result = await sendWhatsAppText({ to, body, userId, purpose });
  if (!result.ok) console.error("[whatsapp-inbound] reply failed", { purpose, error: result.error });
}
