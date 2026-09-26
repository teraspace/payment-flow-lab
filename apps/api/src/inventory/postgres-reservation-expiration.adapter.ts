import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PoolClient } from 'pg';

interface ExpiredReservationRow {
  id: string;
  checkout_id: string;
  product_id: string;
  quantity: number;
}

@Injectable()
export class PostgresReservationExpirationAdapter {
  async releaseExpired(client: PoolClient): Promise<number> {
    const expired = await client.query<ExpiredReservationRow>(`
      SELECT r.id, r.checkout_id, r.product_id, r.quantity
      FROM reservations AS r
      JOIN checkouts AS c ON c.id = r.checkout_id
      WHERE r.state = 'HELD'
        AND r.expires_at <= now()
        AND c.state IN ('RESERVED', 'PAYMENT_FAILED')
      ORDER BY r.checkout_id, r.product_id, r.id
    `);

    let releasedCount = 0;

    for (const candidate of expired.rows) {
      // Keep the shared checkout -> reservation -> product lock order used by
      // payment transitions. Recheck every predicate after acquiring locks.
      const checkout = await client.query<{ id: string }>(
        `SELECT id FROM checkouts
         WHERE id = $1 AND state IN ('RESERVED', 'PAYMENT_FAILED')
         FOR UPDATE`,
        [candidate.checkout_id],
      );
      if (checkout.rowCount !== 1) continue;

      const reservation = await client.query<ExpiredReservationRow>(
        `SELECT id, checkout_id, product_id, quantity
         FROM reservations
         WHERE id = $1 AND checkout_id = $2
           AND state = 'HELD' AND expires_at <= now()
         FOR UPDATE`,
        [candidate.id, candidate.checkout_id],
      );
      const held = reservation.rows[0];
      if (!held) continue;

      const released = await client.query<ExpiredReservationRow>(
        `
          UPDATE reservations
          SET state = 'RELEASED', released_at = now()
          WHERE id = $1 AND state = 'HELD' AND expires_at <= now()
          RETURNING id, checkout_id, product_id, quantity
        `,
        [held.id],
      );

      const transitioned = released.rows[0];
      if (!transitioned) continue;

      const inventory = await client.query(
        `
          UPDATE products
          SET reserved_quantity = reserved_quantity - $2,
              updated_at = now()
          WHERE id = $1 AND reserved_quantity >= $2
          RETURNING id
        `,
        [transitioned.product_id, transitioned.quantity],
      );

      if (inventory.rowCount !== 1) {
        throw new InternalServerErrorException(
          'Inventory reservation counters are inconsistent.',
        );
      }

      await client.query(
        `
          UPDATE checkouts
          SET state = 'EXPIRED', updated_at = now()
          WHERE id = $1 AND state IN ('RESERVED', 'PAYMENT_FAILED')
        `,
        [transitioned.checkout_id],
      );

      releasedCount += 1;
    }

    return releasedCount;
  }
}
