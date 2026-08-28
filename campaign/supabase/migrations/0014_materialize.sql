-- =============================================================================
-- 0014  Audience materialization
-- =============================================================================
-- Turning a campaign's audience into concrete, individually-authorizable jobs.
-- Rendering happens HERE (once, at materialization), not in the worker, so the
-- exact bytes that will be sent are stored and auditable before anything is
-- authorized.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Merge-field rendering. Supports {{first_name}}, {{last_name}}, {{company}},
-- {{job_title}}, {{email}} and any key in contacts.attributes, plus a default
-- syntax: {{first_name|there}}.
--
-- HTML rendering escapes every substituted value. A contact whose name is
-- "<script>" must never become executable markup in a preview or a mail client.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.html_escape(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT replace(replace(replace(replace(replace(
           COALESCE(p, ''),
           '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

CREATE OR REPLACE FUNCTION campaign.render_template(
  p_template text,
  p_contact  campaign.contacts,
  p_escape   boolean DEFAULT false,
  -- System fields resolved per job rather than per contact: the unsubscribe
  -- link, the organisation's postal address, and the org name. Passing them in
  -- keeps this function pure and testable.
  p_system   jsonb DEFAULT '{}'::jsonb
)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_out    text := COALESCE(p_template, '');
  v_match  text[];
  v_token  text;
  v_key    text;
  v_default text;
  v_value  text;
  v_guard  integer := 0;
BEGIN
  -- Replace one placeholder at a time so a substituted value containing
  -- "{{...}}" is never itself re-expanded.
  LOOP
    v_guard := v_guard + 1;
    EXIT WHEN v_guard > 200;

    SELECT regexp_match(v_out, '\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}') INTO v_match;
    EXIT WHEN v_match IS NULL;

    v_key     := v_match[1];
    v_default := COALESCE(v_match[2], '');
    -- The literal span to replace, including the braces.
    v_token   := substring(v_out from '\{\{\s*[a-zA-Z0-9_.]+\s*(?:\|[^}]*)?\}\}');
    EXIT WHEN v_token IS NULL;

    v_value := CASE lower(v_key)
      WHEN 'first_name' THEN p_contact.first_name
      WHEN 'last_name'  THEN p_contact.last_name
      WHEN 'full_name'  THEN NULLIF(btrim(COALESCE(p_contact.first_name, '') || ' ' || COALESCE(p_contact.last_name, '')), '')
      WHEN 'company'    THEN p_contact.company
      WHEN 'job_title'  THEN p_contact.job_title
      WHEN 'email'      THEN p_contact.email::text
      WHEN 'phone'      THEN p_contact.phone
      -- System fields win over contact attributes so a malicious or accidental
      -- CSV column named "unsubscribe_url" cannot hijack the real link.
      ELSE COALESCE(p_system ->> v_key, p_contact.attributes ->> v_key)
    END;

    v_value := COALESCE(NULLIF(btrim(COALESCE(v_value, '')), ''), v_default);
    IF p_escape THEN
      v_value := campaign.html_escape(v_value);
    END IF;

    v_out := replace(v_out, v_token, v_value);
  END LOOP;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- materialize_campaign_jobs
--
-- Idempotent: running it twice creates no extra jobs, because
-- UNIQUE (campaign_id, contact_id) and the live-recipient index reject them.
-- Suppressed recipients are materialized as 'suppressed', never as 'queued' --
-- they appear in the audit as deliberately not-sent rather than silently absent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.materialize_campaign_jobs(p_campaign_id uuid)
RETURNS TABLE (created integer, suppressed integer, skipped_duplicate integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c            campaign.campaigns%ROWTYPE;
  cv           campaign.campaign_content_versions%ROWTYPE;
  r            record;
  ct           campaign.contacts%ROWTYPE;
  v_created    integer := 0;
  v_suppressed integer := 0;
  v_dupe       integer := 0;
  v_subject    text;
  v_html       text;
  v_text       text;
  v_limit      integer;
  v_job_id     uuid;
  v_token      uuid;
  v_system     jsonb;
  cs           campaign.compliance_settings%ROWTYPE;
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign % not found', p_campaign_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.current_version_id IS NULL THEN
    RAISE EXCEPTION 'campaign % has no content version', p_campaign_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF c.status NOT IN ('draft', 'pending_approval', 'approved', 'scheduled', 'running') THEN
    RAISE EXCEPTION 'campaign % is %, cannot materialize', p_campaign_id, c.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO cv FROM campaign.campaign_content_versions WHERE id = c.current_version_id;
  SELECT * INTO cs FROM campaign.compliance_settings WHERE id = true;

  -- Refuse to render bodies whose unsubscribe link would be empty. This is the
  -- failure the compliance gate alone did not catch: the template contained the
  -- placeholder, but nothing was configured to fill it in.
  IF COALESCE(btrim(cs.app_base_url), '') = ''
     AND position('{{unsubscribe_url}}' IN
         COALESCE(cv.body_html_template, '') || COALESCE(cv.body_text_template, '')) > 0 THEN
    RAISE EXCEPTION 'compliance_settings.app_base_url must be set before materializing a campaign that uses {{unsubscribe_url}}'
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(btrim(cs.postal_address), '') = ''
     AND position('{{postal_address}}' IN
         COALESCE(cv.body_html_template, '') || COALESCE(cv.body_text_template, '')) > 0 THEN
    RAISE EXCEPTION 'compliance_settings.postal_address must be set before materializing a campaign that uses {{postal_address}}'
      USING ERRCODE = 'check_violation';
  END IF;

  -- "How many contacts should receive this campaign." NULL means everyone.
  v_limit := c.target_count;

  FOR r IN
    SELECT cr.contact_id, cr.position
    FROM campaign.campaign_recipients cr
    JOIN campaign.contacts ctc ON ctc.id = cr.contact_id
    WHERE cr.campaign_id = p_campaign_id
      AND ctc.deleted_at IS NULL
      AND ctc.status = 'active'
      -- Do not re-materialize a contact that already has a job.
      AND NOT EXISTS (
        SELECT 1 FROM campaign.email_jobs ej
        WHERE ej.campaign_id = p_campaign_id AND ej.contact_id = cr.contact_id
      )
    ORDER BY cr.position
    LIMIT CASE WHEN v_limit IS NULL THEN NULL ELSE
      GREATEST(v_limit - (SELECT count(*) FROM campaign.email_jobs
                          WHERE campaign_id = p_campaign_id AND status <> 'cancelled'), 0)
    END
  LOOP
    SELECT * INTO ct FROM campaign.contacts WHERE id = r.contact_id;

    -- The id and token are generated here so the unsubscribe link can be baked
    -- into the rendered body that this very row will store.
    v_job_id := gen_random_uuid();
    v_token  := gen_random_uuid();
    v_system := jsonb_build_object(
      'unsubscribe_url', rtrim(COALESCE(cs.app_base_url, ''), '/') || '/u/' || v_token::text,
      'postal_address',  COALESCE(cs.postal_address, ''),
      'org_name',        COALESCE(cs.org_name, ''),
      'campaign_name',   c.name
    );

    v_subject := campaign.render_template(cv.subject_template, ct, false, v_system);
    v_html    := campaign.render_template(cv.body_html_template, ct, true,  v_system);
    v_text    := campaign.render_template(cv.body_text_template, ct, false, v_system);

    BEGIN
      INSERT INTO campaign.email_jobs (
        id, unsubscribe_token,
        campaign_id, contact_id, sender_account_id,
        content_version_id, content_version_hash,
        recipient_email, recipient_name,
        subject, body_html, body_text,
        status, max_attempts, priority, scheduled_for, available_at
      ) VALUES (
        v_job_id, v_token,
        p_campaign_id, ct.id, c.sender_account_id,
        cv.id, cv.content_hash,
        ct.email,
        NULLIF(btrim(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, '')), ''),
        v_subject, v_html, v_text,
        CASE WHEN campaign.is_suppressed(ct.email::text, p_campaign_id)
             THEN 'suppressed'::campaign.job_status
             ELSE 'pending'::campaign.job_status END,
        c.max_attempts, r.position, now(), now()
      );

      IF campaign.is_suppressed(ct.email::text, p_campaign_id) THEN
        UPDATE campaign.email_jobs
           SET suppressed_reason = campaign.suppression_reason_for(ct.email::text, p_campaign_id),
               skip_reason = 'recipient_suppressed'
         WHERE campaign_id = p_campaign_id AND contact_id = ct.id;
        v_suppressed := v_suppressed + 1;
      ELSE
        v_created := v_created + 1;
      END IF;

    EXCEPTION WHEN unique_violation THEN
      -- Another contact row shares this address, or a concurrent
      -- materialization already created the job. Either way: not a second email.
      v_dupe := v_dupe + 1;
    END;
  END LOOP;

  PERFORM campaign.write_audit(
    p_action => 'campaign.materialized', p_entity_type => 'campaign',
    p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id,
    p_metadata => jsonb_build_object('created', v_created, 'suppressed', v_suppressed,
                                     'skipped_duplicate', v_dupe,
                                     'content_version', cv.version));

  RETURN QUERY SELECT v_created, v_suppressed, v_dupe;
END;
$$;

COMMENT ON FUNCTION campaign.materialize_campaign_jobs(uuid) IS
  'Creates one email_job per eligible recipient, with fully rendered content snapshotted. Idempotent: re-running creates nothing extra.';
