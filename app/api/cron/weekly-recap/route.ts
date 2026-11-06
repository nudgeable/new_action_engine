import { NextResponse } from "next/server";
import { isResendConfigured } from "@/lib/resend";
import { sendWeeklyUnvalidatedRecap } from "@/lib/action-reminders";
import { sendWhatsAppWeeklyRecap } from "@/lib/whatsapp-reminders";

/**
 * Friday week-recap cron — separate from the main daily scheduler because it
 * runs at a different time of day (12:30 PM IST / 7:00 UTC, Fridays only —
 * see vercel.json) and covers every active participant regardless of their
 * own daily/weekly cadence. Sends a recap of everything still unvalidated
 * for the week, with a single "I completed all" bulk-complete link. The same
 * run sends the WhatsApp recap (lib/whatsapp-reminders.ts), before the Resend
 * check so WhatsApp doesn't depend on email being configured.
 *
 * Idempotent via the (subscription, recap_date) claim in
 * lib/action-reminders.ts, so a rerun on the same Friday cannot double send.
 *
 * Auth: checks Authorization: Bearer <CRON_SECRET> header (set by Vercel
 * automatically when CRON_SECRET env var is present) or ?secret= query param
 * for local testing.
 */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const authHeader = request.headers.get("authorization");
    const querySecret = new URL(request.url).searchParams.get("secret");
    const bearerToken = authHeader?.replace("Bearer ", "");

    if (bearerToken !== expected && querySecret !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const whatsappRecap = await sendWhatsAppWeeklyRecap();

  if (!isResendConfigured()) {
    return NextResponse.json({
      ok: true,
      message: "Resend not configured — skipped weekly recap",
      whatsappRecap,
      recap: { sent: 0, failed: 0, skippedEmpty: 0, skippedDisabled: 0, skippedClaimed: 0 },
    });
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL!;
  const recap = await sendWeeklyUnvalidatedRecap(fromEmail);

  return NextResponse.json({ ok: true, recap, whatsappRecap });
}
