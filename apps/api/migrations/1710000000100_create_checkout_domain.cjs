exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE products
      ADD COLUMN description text NOT NULL DEFAULT '',
      ADD COLUMN image_url text NOT NULL DEFAULT '';

    -- A duplicate SKU must fail the migration; skipping it would make rollback
    -- indistinguishable from ownership of a pre-existing product row.
    INSERT INTO products (
      sku, name, description, image_url, price_minor, currency,
      physical_quantity, reserved_quantity, active
    ) VALUES
      (
        'desk-notebook',
        'Cuaderno de puntos',
        'Cuaderno de tapa dura para notas, listas y bocetos.',
        '/catalog/notebook.svg',
        29000,
        'COP',
        7,
        0,
        true
      ),
      (
        'urban-bottle',
        'Botella térmica',
        'Botella reutilizable de acero con tapa de cierre seguro.',
        '/catalog/bottle.svg',
        59000,
        'COP',
        4,
        0,
        true
      ),
      (
        'canvas-tote',
        'Bolso de lona',
        'Bolso liviano de lona para llevar lo esencial todos los días.',
        '/catalog/tote.svg',
        36000,
        'COP',
        5,
        0,
        true
      );

    CREATE TABLE guest_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash char(64) NOT NULL UNIQUE
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      CONSTRAINT guest_sessions_expiry_after_creation
        CHECK (expires_at > created_at)
    );

    CREATE INDEX guest_sessions_expiry_idx
      ON guest_sessions (expires_at);

    CREATE TABLE customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
      email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient text NOT NULL CHECK (length(btrim(recipient)) BETWEEN 1 AND 120),
      address text NOT NULL CHECK (length(btrim(address)) BETWEEN 5 AND 240),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE checkouts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_session_id uuid NOT NULL REFERENCES guest_sessions(id),
      customer_id uuid NOT NULL REFERENCES customers(id),
      delivery_id uuid NOT NULL REFERENCES deliveries(id),
      state text NOT NULL CHECK (state IN ('RESERVED', 'EXPIRED')),
      subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
      base_fee_minor bigint NOT NULL CHECK (base_fee_minor >= 0),
      delivery_fee_minor bigint NOT NULL CHECK (delivery_fee_minor >= 0),
      total_minor bigint NOT NULL CHECK (total_minor >= 0),
      currency char(3) NOT NULL DEFAULT 'COP',
      reservation_expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT checkouts_total_matches_components
        CHECK (total_minor = subtotal_minor + base_fee_minor + delivery_fee_minor)
    );

    CREATE INDEX checkouts_guest_session_created_idx
      ON checkouts (guest_session_id, created_at DESC);
    CREATE INDEX checkouts_reservation_expiry_idx
      ON checkouts (reservation_expires_at)
      WHERE state = 'RESERVED';

    CREATE TABLE checkout_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      checkout_id uuid NOT NULL REFERENCES checkouts(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id),
      sku_snapshot text NOT NULL,
      name_snapshot text NOT NULL,
      quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
      line_total_minor bigint NOT NULL CHECK (line_total_minor = unit_price_minor * quantity),
      CONSTRAINT checkout_items_product_once UNIQUE (checkout_id, product_id)
    );

    CREATE TABLE reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      checkout_id uuid NOT NULL UNIQUE REFERENCES checkouts(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id),
      quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      state text NOT NULL CHECK (state IN ('HELD', 'RELEASED')),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      released_at timestamptz,
      CONSTRAINT reservations_release_timestamp_matches_state
        CHECK ((state = 'HELD' AND released_at IS NULL)
          OR (state = 'RELEASED' AND released_at IS NOT NULL))
    );

    CREATE INDEX reservations_expiry_idx
      ON reservations (expires_at, id)
      WHERE state = 'HELD';

    CREATE TABLE idempotency_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_session_id uuid NOT NULL REFERENCES guest_sessions(id),
      operation text NOT NULL CHECK (operation = 'CREATE_CHECKOUT'),
      idempotency_key_hash char(64) NOT NULL
        CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
      fingerprint_hash char(64) NOT NULL
        CHECK (fingerprint_hash ~ '^[0-9a-f]{64}$'),
      checkout_id uuid NOT NULL REFERENCES checkouts(id)
        DEFERRABLE INITIALLY DEFERRED,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT idempotency_scope_key_unique
        UNIQUE (guest_session_id, operation, idempotency_key_hash)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE idempotency_records;
    DROP TABLE reservations;
    DROP TABLE checkout_items;
    DROP TABLE checkouts;
    DROP TABLE deliveries;
    DROP TABLE customers;
    DROP TABLE guest_sessions;
    DELETE FROM products
      WHERE sku IN ('desk-notebook', 'urban-bottle', 'canvas-tote');
    ALTER TABLE products
      DROP COLUMN image_url,
      DROP COLUMN description;
  `);
};
