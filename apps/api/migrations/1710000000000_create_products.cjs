exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sku text NOT NULL UNIQUE,
      name text NOT NULL,
      price_minor bigint NOT NULL CHECK (price_minor >= 0),
      currency char(3) NOT NULL DEFAULT 'COP',
      physical_quantity integer NOT NULL DEFAULT 0 CHECK (physical_quantity >= 0),
      reserved_quantity integer NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT products_reserved_within_physical
        CHECK (reserved_quantity <= physical_quantity)
    )
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE products');
};
