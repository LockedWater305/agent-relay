-- Desktop Library history is durable across HTTP-port changes. Original text
-- records are append-only within an owner's deletion generation.
CREATE TABLE IF NOT EXISTS buzzy_library_vault_store (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  store_id UUID NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS buzzy_library_vault_owner (
  user_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE IF NOT EXISTS buzzy_library_vault (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  record_hash TEXT NOT NULL,
  job_id TEXT NOT NULL,
  document JSONB NOT NULL,
  record_bytes INTEGER NOT NULL CHECK (record_bytes > 0 AND record_bytes <= 8388608),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT buzzy_library_vault_owner_generation_hash_key UNIQUE (user_id, generation, record_hash)
);
CREATE INDEX IF NOT EXISTS buzzy_library_vault_user_id_idx
  ON buzzy_library_vault (user_id, generation, id);

-- Both routines lock the same owner row. They are VOLATILE, SECURITY INVOKER:
-- each SQL command gets a fresh READ COMMITTED snapshot after obtaining that
-- lock. A single CTE delete could instead retain its pre-wait snapshot and
-- miss an import that committed while it waited. No elevated database rights,
-- dynamic SQL, filesystem operations or provider calls are involved.
CREATE OR REPLACE FUNCTION buzzy_library_vault_import(
  p_user_id TEXT, p_store_id UUID, p_generation BIGINT, p_records JSONB
) RETURNS TABLE (id TEXT, record_hash TEXT, job_id TEXT, document JSONB, result_code TEXT)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE current_generation BIGINT;
BEGIN
  INSERT INTO buzzy_library_vault_owner (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT o.generation INTO current_generation FROM buzzy_library_vault_owner o
    WHERE o.user_id = p_user_id FOR UPDATE;
  IF current_generation <> p_generation OR NOT EXISTS (
    SELECT 1 FROM buzzy_library_vault_store s WHERE s.singleton AND s.store_id = p_store_id
  ) THEN
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, NULL::jsonb, 'vault_store_changed'::text;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_records) AS x(job_id TEXT)
    JOIN buzzy_jobs j ON j.id = x.job_id WHERE j.user_id <> p_user_id
  ) THEN
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, NULL::jsonb, 'vault_job_conflict'::text;
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO buzzy_library_vault AS v (user_id, generation, record_hash, job_id, document, record_bytes)
    SELECT p_user_id, p_generation, x.record_hash, x.job_id, x.document, x.record_bytes
    FROM jsonb_to_recordset(p_records)
      AS x(record_hash TEXT, job_id TEXT, document JSONB, record_bytes INTEGER)
    ON CONFLICT ON CONSTRAINT buzzy_library_vault_owner_generation_hash_key
      DO UPDATE SET record_hash = EXCLUDED.record_hash
    RETURNING v.id::text, v.record_hash, v.job_id, v.document, 'stored'::text;
END;
$$;

CREATE OR REPLACE FUNCTION buzzy_library_vault_delete(p_user_id TEXT)
RETURNS BIGINT LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE deleted_count BIGINT;
BEGIN
  INSERT INTO buzzy_library_vault_owner (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM buzzy_library_vault_owner o WHERE o.user_id = p_user_id FOR UPDATE;
  DELETE FROM buzzy_library_vault v WHERE v.user_id = p_user_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  UPDATE buzzy_library_vault_owner SET generation = generation + 1 WHERE user_id = p_user_id;
  RETURN deleted_count;
END;
$$;
