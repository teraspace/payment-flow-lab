import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PoolClient } from 'pg';

interface ExpiredReservationRow {
  id: string;
  checkout_id: string;
  product_id: string;
  quantity: number;
}

@Injectable()
export class ReservationExpirationService {
  async releaseExpired(client: PoolClient): Promise<number> {
    const expired = await client.query<ExpiredReservationRow>(`
      SELECT r.id, r.checkout_id, r.product_id, r.quantity
      FROM reservations AS r
      JOIN checkouts AS c ON c.id = r.checkout_id
      WHERE r.state = 'HELD'
        AND r.expires_at <= now()
        AND c.state IN ('RESERVED', 'PAYMENT_FAILED')
      ORDER BY r.product_id, r.id
      FOR UPDATE OF r
    `);

    let releasedCount = 0;

    for (const reservation of expired.rows) {
      const released = await client.query<ExpiredReservationRow>(
        `
          UPDATE reservations
          SET state = 'RELEASED', released_at = now()
          WHERE id = $1 AND state = 'HELD' AND expires_at <= now()
          RETURNING id, checkout_id, product_id, quantity
        `,
        [reservation.id],
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
