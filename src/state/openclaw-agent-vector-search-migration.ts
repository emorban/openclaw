// The predecessor seal validates these owner-persisted definitions before this migration runs.
export const AGENT_VECTOR_SEARCH_POSTGRES_SQL = `DO $migration$
DECLARE definition jsonb; vector_index jsonb; extension_schema text; dimensions integer;
BEGIN
  FOR definition IN
    SELECT value FROM openclaw_schema_meta meta,
      jsonb_each(coalesce((to_jsonb(meta)->>'search_extensions')::jsonb, '{}'::jsonb))
    WHERE meta.store = 'agent'
  LOOP
    IF definition->>'mode' = 'keyword-only' THEN CONTINUE; END IF;
    extension_schema := coalesce(definition->>'extensionSchema', 'public');
    FOR vector_index IN SELECT value FROM jsonb_each(coalesce(definition->'vector', '{}'::jsonb))
    LOOP
      dimensions := (vector_index->'postgres'->>'dimensions')::integer;
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN embedding_bits bit(%s) GENERATED ALWAYS AS (CASE WHEN %I.vector_norm(embedding) > 0 THEN %I.binary_quantize(embedding)::bit(%s) ELSE NULL END) STORED',
        vector_index->>'table', dimensions, extension_schema, extension_schema, dimensions);
    END LOOP;
  END LOOP;
END $migration$;`;
