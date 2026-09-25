exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE checkouts
      DROP CONSTRAINT checkouts_state_check,
      ADD CONSTRAINT checkouts_state_check
        CHECK (state IN (
          'RESERVED', 'PAYMENT_PENDING', 'UNKNOWN_OUTCOME',
          'PAYMENT_FAILED', 'PAID', 'CANCEL_PENDING', 'CANCELLED',
          'EXPIRED', 'FULFILLMENT_EXCEPTION'
        ));

    ALTER TABLE reservations
      DROP CONSTRAINT reservations_state_check,
      ADD COLUMN committed_at timestamptz,
      ADD CONSTRAINT reservations_state_check
        CHECK (state IN ('HELD', 'RELEASED', 'COMMITTED')),
      DROP CONSTRAINT reservations_release_timestamp_matches_state,
      ADD CONSTRAINT reservations_terminal_timestamp_matches_state
        CHECK (
          (state = 'HELD' AND released_at IS NULL AND committed_at IS NULL)
          OR (state = 'RELEASED' AND released_at IS NOT NULL AND committed_at IS NULL)
          OR (state = 'COMMITTED' AND released_at IS NULL AND committed_at IS NOT NULL)
        );

    CREATE TABLE payment_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      checkout_id uuid NOT NULL REFERENCES checkouts(id),
      attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 10),
      state text NOT NULL CHECK (state IN (
        'CREATED', 'DISPATCHING', 'FAILED_LOCAL', 'PENDING',
        'UNKNOWN_OUTCOME', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'
      )),
      idempotency_key_hash char(64) NOT NULL
        CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
      request_fingerprint_hash char(64)
        CHECK (request_fingerprint_hash IS NULL
          OR request_fingerprint_hash ~ '^[0-9a-f]{64}$'),
      provider_reference varchar(255) NOT NULL UNIQUE,
      provider_transaction_id varchar(255) UNIQUE,
      amount_cop bigint NOT NULL CHECK (amount_cop >= 0),
      currency char(3) NOT NULL DEFAULT 'COP',
      provider_status text CHECK (provider_status IS NULL OR provider_status IN (
        'PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'
      )),
      provider_http_status integer CHECK (
        provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599
      ),
      dispatch_started_at timestamptz,
      unknown_outcome_at timestamptz,
      provider_status_updated_at timestamptz,
      last_reconciled_at timestamptz,
      reconciliation_lease_until timestamptz,
      manual_review_required_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_attempt_checkout_key_unique
        UNIQUE (checkout_id, idempotency_key_hash),
      CONSTRAINT payment_attempt_checkout_number_unique
        UNIQUE (checkout_id, attempt_number),
      CONSTRAINT payment_attempt_dispatch_state_matches_timestamp
        CHECK ((state = 'CREATED' AND dispatch_started_at IS NULL)
          OR (state <> 'CREATED' AND dispatch_started_at IS NOT NULL)),
      CONSTRAINT payment_attempt_unknown_state_matches_timestamp
        CHECK ((state = 'UNKNOWN_OUTCOME' AND unknown_outcome_at IS NOT NULL)
          OR (state <> 'UNKNOWN_OUTCOME' AND unknown_outcome_at IS NULL))
    );

    CREATE UNIQUE INDEX payment_attempts_one_unresolved_per_checkout_idx
      ON payment_attempts (checkout_id)
      WHERE state IN ('CREATED', 'DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME');

    CREATE INDEX payment_attempts_reconciliation_idx
      ON payment_attempts (state, last_reconciled_at, created_at)
      WHERE state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME');

    CREATE TABLE payment_event_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_fingerprint char(64) NOT NULL UNIQUE
        CHECK (event_fingerprint ~ '^[0-9a-f]{64}$'),
      payment_attempt_id uuid REFERENCES payment_attempts(id) ON DELETE SET NULL,
      provider_transaction_id varchar(255) NOT NULL,
      provider_reference varchar(255) NOT NULL,
      provider_status text NOT NULL CHECK (provider_status IN (
        'PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'
      )),
      amount_in_cents bigint NOT NULL CHECK (amount_in_cents >= 0),
      currency char(3) NOT NULL,
      event_occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      disposition text NOT NULL CHECK (disposition IN (
        'APPLIED', 'DUPLICATE', 'UNMATCHED', 'MISMATCH', 'STALE', 'IGNORED'
      ))
    );

    CREATE INDEX payment_event_receipts_received_idx
      ON payment_event_receipts (received_at, id);

    CREATE TABLE fulfillments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      checkout_id uuid NOT NULL UNIQUE REFERENCES checkouts(id),
      state text NOT NULL CHECK (state IN (
        'READY', 'FULFILLMENT_EXCEPTION', 'CANCELLED'
      )),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM payment_attempts)
        OR EXISTS (SELECT 1 FROM payment_event_receipts)
        OR EXISTS (SELECT 1 FROM fulfillments)
        OR EXISTS (
          SELECT 1 FROM checkouts
          WHERE state NOT IN ('RESERVED', 'EXPIRED')
        )
        OR EXISTS (
          SELECT 1 FROM reservations
          WHERE state = 'COMMITTED'
        ) THEN
        RAISE EXCEPTION
          'Cannot roll back payment lifecycle after attempts, events, fulfillment, or committed inventory exist.';
      END IF;
    END $$;

    DROP TABLE fulfillments;
    DROP TABLE payment_event_receipts;
    DROP TABLE payment_attempts;

    ALTER TABLE reservations
      DROP CONSTRAINT reservations_terminal_timestamp_matches_state,
      DROP CONSTRAINT reservations_state_check,
      DROP COLUMN committed_at,
      ADD CONSTRAINT reservations_state_check
        CHECK (state IN ('HELD', 'RELEASED')),
      ADD CONSTRAINT reservations_release_timestamp_matches_state
        CHECK ((state = 'HELD' AND released_at IS NULL)
          OR (state = 'RELEASED' AND released_at IS NOT NULL));

    ALTER TABLE checkouts
      DROP CONSTRAINT checkouts_state_check,
      ADD CONSTRAINT checkouts_state_check
        CHECK (state IN ('RESERVED', 'EXPIRED'));
  `);
};
