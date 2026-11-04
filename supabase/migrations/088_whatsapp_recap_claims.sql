-- Friday recap on WhatsApp (docs/WHATSAPP_REMINDERS_PLAN.md).
--
-- lib/whatsapp-reminders.ts sends the plan_recap_N template from the Friday
-- weekly-recap cron. It keeps its own claims rather than reusing
-- whatsapp_reminder_claims: that table is unique per plan per day, so a Friday
-- reminder and a Friday recap would collide. Same rules otherwise: one claim
-- per plan per recap date (always the Friday, including a Saturday catch-up
-- run), and a failed attempt can be reclaimed after 15 minutes, up to three
-- attempts in total.

CREATE TABLE IF NOT EXISTS public.whatsapp_recap_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id UUID REFERENCES public.personal_action_subscriptions(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  cohort_id UUID REFERENCES public.cohorts(id) ON DELETE CASCADE NOT NULL,
  recap_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  -- Set once Meta accepts the message; delivery/read/failure is tracked in
  -- whatsapp_message_logs by the webhook under the same wamid.
  wamid TEXT,
  template_name TEXT,
  action_count INTEGER,
  last_error TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscription_id, recap_date)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_recap_claims_date
  ON public.whatsapp_recap_claims(recap_date DESC, status);

ALTER TABLE public.whatsapp_recap_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only whatsapp_recap_claims" ON public.whatsapp_recap_claims
  FOR ALL USING (false) WITH CHECK (false);

COMMENT ON TABLE public.whatsapp_recap_claims IS
  'One row per plan per Friday a WhatsApp recap was attempted. Guards against double sends; wamid links to whatsapp_message_logs for delivery status.';

-- Returns a claim id when this cron invocation may send (same contract as
-- claim_whatsapp_reminder).
CREATE OR REPLACE FUNCTION public.claim_whatsapp_recap(
  p_subscription_id UUID,
  p_user_id UUID,
  p_cohort_id UUID,
  p_recap_date DATE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim_id UUID;
BEGIN
  INSERT INTO public.whatsapp_recap_claims (subscription_id, user_id, cohort_id, recap_date)
  VALUES (p_subscription_id, p_user_id, p_cohort_id, p_recap_date)
  ON CONFLICT (subscription_id, recap_date)
  DO UPDATE SET
    status = 'sending',
    attempt_count = whatsapp_recap_claims.attempt_count + 1,
    last_error = NULL,
    claimed_at = NOW(),
    updated_at = NOW()
  WHERE whatsapp_recap_claims.status = 'failed'
    AND whatsapp_recap_claims.attempt_count < 3
    AND whatsapp_recap_claims.updated_at <= NOW() - INTERVAL '15 minutes'
  RETURNING id INTO v_claim_id;

  RETURN v_claim_id;
END;
$$;

-- Supabase's default privileges also grant new functions to anon and
-- authenticated directly, so revoking from PUBLIC alone is not enough here.
REVOKE ALL ON FUNCTION public.claim_whatsapp_recap(UUID, UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_recap(UUID, UUID, UUID, DATE) TO service_role;
