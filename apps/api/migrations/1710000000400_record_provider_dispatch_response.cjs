exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE payment_attempts
      ADD COLUMN provider_response_received_at timestamptz;

    -- Before this migration DISPATCHING meant the provider call may have
    -- started. Preserve that uncertainty instead of treating it as safe to retry.
    UPDATE payment_attempts
    SET state = 'UNKNOWN_OUTCOME',
        unknown_outcome_at = COALESCE(unknown_outcome_at, now())
    WHERE state = 'DISPATCHING';

    -- PENDING rows from the previous flow already had a provider response.
    UPDATE payment_attempts
    SET provider_response_received_at = COALESCE(provider_status_updated_at, updated_at)
    WHERE state = 'PENDING' AND provider_status IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE payment_attempts
      DROP COLUMN provider_response_received_at;
  `);
};
