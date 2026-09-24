exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customers
      ALTER COLUMN full_name DROP NOT NULL,
      ALTER COLUMN email DROP NOT NULL,
      ADD CONSTRAINT customers_personal_data_redacted_together
        CHECK ((full_name IS NULL) = (email IS NULL));

    ALTER TABLE deliveries
      ALTER COLUMN recipient DROP NOT NULL,
      ALTER COLUMN address DROP NOT NULL,
      ADD CONSTRAINT deliveries_personal_data_redacted_together
        CHECK ((recipient IS NULL) = (address IS NULL));

    ALTER TABLE idempotency_records
      ALTER COLUMN fingerprint_hash DROP NOT NULL;

    CREATE INDEX checkouts_personal_data_retention_idx
      ON checkouts (created_at, id);

    CREATE INDEX idempotency_records_checkout_fingerprint_idx
      ON idempotency_records (checkout_id)
      WHERE fingerprint_hash IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM customers
        WHERE full_name IS NULL OR email IS NULL
      ) OR EXISTS (
        SELECT 1 FROM deliveries
        WHERE recipient IS NULL OR address IS NULL
      ) OR EXISTS (
        SELECT 1 FROM idempotency_records
        WHERE fingerprint_hash IS NULL
      ) THEN
        RAISE EXCEPTION
          'Cannot roll back checkout PII retention after data has been redacted; restore the original data before retrying.';
      END IF;
    END;
    $$;

    DROP INDEX idempotency_records_checkout_fingerprint_idx;
    DROP INDEX checkouts_personal_data_retention_idx;

    ALTER TABLE idempotency_records
      ALTER COLUMN fingerprint_hash SET NOT NULL;

    ALTER TABLE deliveries
      DROP CONSTRAINT deliveries_personal_data_redacted_together,
      ALTER COLUMN recipient SET NOT NULL,
      ALTER COLUMN address SET NOT NULL;

    ALTER TABLE customers
      DROP CONSTRAINT customers_personal_data_redacted_together,
      ALTER COLUMN full_name SET NOT NULL,
      ALTER COLUMN email SET NOT NULL;
  `);
};
