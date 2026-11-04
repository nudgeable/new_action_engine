-- Record where a participant completed an action: user_actions.completed_via
-- is 'whatsapp' when they tapped Done on a WhatsApp reminder and 'app' for
-- every other completion (the dashboard, validation, older scored plans).
-- NULL while the action is not completed.
--
-- Completions go through several RPCs and server actions, so rather than
-- passing a channel to each of them, a trigger stamps the column whenever
-- status moves to 'success'. complete_action_for_user (redefined below,
-- otherwise unchanged from 085) sets app.completed_via = 'whatsapp' for its
-- transaction; everything else falls back to 'app'.

ALTER TABLE public.user_actions
  ADD COLUMN IF NOT EXISTS completed_via TEXT
  CHECK (completed_via IN ('app', 'whatsapp'));

COMMENT ON COLUMN public.user_actions.completed_via IS
  'Where the participant completed the action: whatsapp (Done tap on a reminder) or app. Set by trg_user_actions_completed_via; NULL when not completed.';

CREATE OR REPLACE FUNCTION public.set_user_action_completed_via()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'success' THEN
    NEW.completed_via := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'success' THEN
    NEW.completed_via := COALESCE(NULLIF(current_setting('app.completed_via', TRUE), ''), 'app');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_actions_completed_via ON public.user_actions;
CREATE TRIGGER trg_user_actions_completed_via
  BEFORE INSERT OR UPDATE OF status ON public.user_actions
  FOR EACH ROW EXECUTE FUNCTION public.set_user_action_completed_via();

CREATE OR REPLACE FUNCTION public.complete_action_for_user(
  p_user_id UUID,
  p_action_id UUID
)
RETURNS TABLE (
  result TEXT,              -- 'completed' | 'already_done' | 'not_assigned' | 'unsupported'
  settle_path TEXT,         -- 'legacy' | 'wallet' | 'validated' (when completed)
  points_added INTEGER,
  completed_late BOOLEAN,
  surprise_unlock_id UUID,
  previous_status TEXT,
  action_title TEXT,
  action_cohort_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action public.actions%ROWTYPE;
  v_user_action public.user_actions%ROWTYPE;
  v_is_wallet BOOLEAN;
  v_points INTEGER := 0;
  v_late BOOLEAN := FALSE;
  v_path TEXT;
  v_unlock_id UUID;
BEGIN
  SELECT * INTO v_action FROM public.actions WHERE id = p_action_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_assigned'::TEXT, NULL::TEXT, 0, FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Reminders only list personal plan actions; anything else is completed in the app.
  IF NOT v_action.is_personal THEN
    RETURN QUERY SELECT 'unsupported'::TEXT, NULL::TEXT, 0, FALSE, NULL::UUID, NULL::TEXT, v_action.title, v_action.cohort_id;
    RETURN;
  END IF;

  SELECT * INTO v_user_action
  FROM public.user_actions
  WHERE user_id = p_user_id AND action_id = p_action_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_assigned'::TEXT, NULL::TEXT, 0, FALSE, NULL::UUID, NULL::TEXT, v_action.title, v_action.cohort_id;
    RETURN;
  END IF;

  IF v_user_action.status = 'success' THEN
    RETURN QUERY SELECT 'already_done'::TEXT, NULL::TEXT, 0, FALSE, NULL::UUID,
      v_user_action.status::TEXT, v_action.title, v_action.cohort_id;
    RETURN;
  END IF;

  -- Act as the participant for the rest of this transaction, so auth.uid()
  -- inside the *_my_* functions resolves to them (both setting styles are
  -- set, covering older and newer auth.uid() implementations).
  PERFORM set_config('request.jwt.claim.sub', p_user_id::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::TEXT, 'role', 'authenticated')::TEXT,
    TRUE
  );
  -- Read by trg_user_actions_completed_via (087).
  PERFORM set_config('app.completed_via', 'whatsapp', TRUE);

  SELECT EXISTS (
    SELECT 1 FROM public.commitment_wallet_actions
    WHERE action_id = p_action_id AND user_id = p_user_id
  ) INTO v_is_wallet;

  IF v_action.cohort_id IS NOT NULL AND NOT v_is_wallet THEN
    -- Older plans scored through the cohort-points system.
    SELECT s.points_delta, s.completed_late INTO v_points, v_late
    FROM public.settle_my_personal_action(p_action_id, TRUE, NULL) AS s;
    v_path := 'legacy';
  ELSIF v_user_action.status = 'failed' AND v_user_action.auto_expired THEN
    -- Retired into Pending validation when the next batch arrived.
    SELECT s.points_added, s.completed_late INTO v_points, v_late
    FROM public.validate_my_commitment_wallet_action(p_action_id, NULL) AS s;
    v_path := 'validated';
  ELSE
    SELECT s.points_added, s.completed_late INTO v_points, v_late
    FROM public.settle_my_commitment_wallet_action(p_action_id, TRUE, NULL) AS s;
    v_path := 'wallet';
  END IF;

  -- Every success opens the action's Surprise Box (plans with boxes enabled).
  -- Best effort, as in completeAction: an unlock failure never fails completion.
  IF v_path <> 'legacy' THEN
    BEGIN
      SELECT u.id INTO v_unlock_id FROM public.unlock_my_surprise_box(p_action_id) AS u LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_unlock_id := NULL;
    END;
  END IF;

  RETURN QUERY SELECT 'completed'::TEXT, v_path, COALESCE(v_points, 0), COALESCE(v_late, FALSE), v_unlock_id,
    v_user_action.status::TEXT, v_action.title, v_action.cohort_id;
END;
$$;

-- Supabase's default privileges also grant new functions to anon and
-- authenticated directly, so revoking from PUBLIC alone is not enough here.
REVOKE ALL ON FUNCTION public.complete_action_for_user(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_action_for_user(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- Backfill. WhatsApp is the only other way to complete an action, so a
-- completion is 'whatsapp' when a Done tap for that action
-- (whatsapp_inbound_messages.reply_payload = 'done:<n>:<id1>,<id2>,…') arrived
-- just before it was saved, and 'app' otherwise. A tap on an action that was
-- already done doesn't count: its completed_at is earlier than the tap.
-- ---------------------------------------------------------------------------
WITH taps AS (
  SELECT
    m.created_at AS tapped_at,
    split_part(
      split_part(m.reply_payload, ':', 3), ',', split_part(m.reply_payload, ':', 2)::INT
    )::UUID AS action_id
  FROM public.whatsapp_inbound_messages m
  WHERE m.reply_payload ~ '^done:[1-3]:[0-9a-f]{32}(,[0-9a-f]{32}){0,2}$'
)
UPDATE public.user_actions ua
SET completed_via = CASE
  WHEN EXISTS (
    SELECT 1 FROM taps t
    WHERE t.action_id = ua.action_id
      AND ua.completed_at BETWEEN t.tapped_at - INTERVAL '5 seconds' AND t.tapped_at + INTERVAL '1 minute'
  ) THEN 'whatsapp'
  ELSE 'app'
END
WHERE ua.status = 'success' AND ua.completed_via IS NULL;
