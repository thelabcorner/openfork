import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916032430_usage_records",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`usage_record\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`agent\` text,
          \`mode\` text,
          \`created_at\` integer,
          \`request_sent_at\` integer,
          \`first_token_at\` integer,
          \`streamed_at\` integer,
          \`completed_at\` integer NOT NULL,
          \`cost_usd\` real,
          \`input_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_read_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_write_tokens\` integer DEFAULT 0 NOT NULL,
          \`output_tokens\` integer DEFAULT 0 NOT NULL,
          \`reasoning_tokens\` integer DEFAULT 0 NOT NULL
        );
      `)
      // One-time compatibility import. New settlements write scalar rows at
      // the producer, so these JSON reads never remain on a steady-state path.
      yield* tx.run(`
        INSERT OR IGNORE INTO \`usage_record\` (
          message_id, session_id, provider_id, model_id, variant, agent, mode,
          created_at, request_sent_at, first_token_at, streamed_at, completed_at,
          cost_usd, input_tokens, cache_read_tokens, cache_write_tokens,
          output_tokens, reasoning_tokens
        )
        SELECT
          m.id,
          m.session_id,
          COALESCE(json_extract(m.data, '$.providerID'), 'unknown'),
          COALESCE(json_extract(m.data, '$.modelID'), 'unknown'),
          json_extract(m.data, '$.variant'),
          json_extract(m.data, '$.agent'),
          json_extract(m.data, '$.mode'),
          json_extract(m.data, '$.time.created'),
          json_extract(m.data, '$.time.requestSentAt'),
          json_extract(m.data, '$.time.firstTokenAt'),
          json_extract(m.data, '$.time.streamedAt'),
          json_extract(m.data, '$.time.completed'),
          json_extract(m.data, '$.cost'),
          COALESCE(json_extract(m.data, '$.tokens.input'), 0),
          COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0),
          COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0),
          COALESCE(json_extract(m.data, '$.tokens.output'), 0),
          COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)
        FROM message m
        WHERE json_extract(m.data, '$.role') = 'assistant'
          AND json_extract(m.data, '$.time.completed') IS NOT NULL;
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO \`usage_record\` (
          message_id, session_id, provider_id, model_id, variant, agent,
          created_at, request_sent_at, first_token_at, streamed_at, completed_at,
          cost_usd, input_tokens, cache_read_tokens, cache_write_tokens,
          output_tokens, reasoning_tokens
        )
        SELECT
          sm.id,
          sm.session_id,
          COALESCE(json_extract(sm.data, '$.model.providerID'), 'unknown'),
          COALESCE(json_extract(sm.data, '$.model.id'), 'unknown'),
          json_extract(sm.data, '$.model.variant'),
          json_extract(sm.data, '$.agent'),
          json_extract(sm.data, '$.time.created'),
          json_extract(sm.data, '$.time.requestSentAt'),
          json_extract(sm.data, '$.time.firstTokenAt'),
          lifecycle.streamed_at,
          json_extract(lifecycle.settlement, '$.completed'),
          json_extract(lifecycle.settlement, '$.cost'),
          COALESCE(json_extract(lifecycle.settlement, '$.tokens.input'), 0),
          COALESCE(json_extract(lifecycle.settlement, '$.tokens.cache.read'), 0),
          COALESCE(json_extract(lifecycle.settlement, '$.tokens.cache.write'), 0),
          COALESCE(json_extract(lifecycle.settlement, '$.tokens.output'), 0),
          COALESCE(json_extract(lifecycle.settlement, '$.tokens.reasoning'), 0)
        FROM session_message sm
        JOIN session_message_lifecycle lifecycle ON lifecycle.message_id = sm.id
        WHERE sm.type = 'assistant'
          AND json_extract(lifecycle.settlement, '$.type') = 'ended';
      `)
      yield* tx.run(`CREATE INDEX \`usage_record_completed_idx\` ON \`usage_record\` (\`completed_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`usage_record_session_completed_idx\` ON \`usage_record\` (\`session_id\`,\`completed_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_record_model_completed_idx\` ON \`usage_record\` (\`provider_id\`,\`model_id\`,\`completed_at\`);`,
      )
      // A local dev database may briefly have received the abandoned
      // SessionTelemetry-owned history table before the ownership audit. It was
      // never a committed contract; clean it up without making fresh installs
      // depend on its existence.
      yield* tx.run(`DROP TABLE IF EXISTS \`session_telemetry_record\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
