import { formatCop, formatDateTime } from '../app/format';
import type { Checkout } from '../app/service-api';

const CHECKOUT_STATE_LABELS: Record<Checkout['state'], string> = {
  RESERVED: 'Inventario reservado',
  PAYMENT_PENDING: 'Pago en proceso',
  UNKNOWN_OUTCOME: 'Resultado por conciliar',
  PAYMENT_FAILED: 'Pago sin aprobar',
  PAID: 'Pedido confirmado',
  CANCEL_PENDING: 'Anulación en proceso',
  CANCELLED: 'Pedido cancelado',
  EXPIRED: 'Reserva vencida',
  FULFILLMENT_EXCEPTION: 'Pedido en revisión',
};

const PRODUCT_IMAGES: Record<string, string> = {
  'desk-notebook': '/catalog/notebook.svg',
  'urban-bottle': '/catalog/bottle.svg',
  'canvas-tote': '/catalog/tote.svg',
};

interface CheckoutSummaryProps {
  checkout: Checkout;
}

export function CheckoutSummary({ checkout }: CheckoutSummaryProps) {
  const redacted = !checkout.customer.fullName || !checkout.customer.email;

  return (
    <aside className="order-summary" aria-labelledby="summary-title">
      <div className="summary-topline">
        <div>
          <p className="eyebrow">Resumen de compra</p>
          <h2 id="summary-title">Tu pedido</h2>
        </div>
        <span className={`checkout-state checkout-state--${checkout.state.toLowerCase()}`}>
          {CHECKOUT_STATE_LABELS[checkout.state]}
        </span>
      </div>

      <div className="summary-item">
        <div className="summary-item-art">
          <img src={PRODUCT_IMAGES[checkout.item.sku] ?? '/catalog/notebook.svg'} alt="" height="44" width="44" />
        </div>
        <div className="summary-item-copy">
          <span>{checkout.item.sku}</span>
          <strong>{checkout.item.name}</strong>
          <small>{checkout.item.quantity} unidad{checkout.item.quantity === 1 ? '' : 'es'}</small>
        </div>
        <strong>{formatCop(checkout.item.lineTotalMinor, checkout.currency)}</strong>
      </div>

      <dl className="price-breakdown">
        <div><dt>Productos</dt><dd>{formatCop(checkout.subtotalMinor, checkout.currency)}</dd></div>
        <div><dt>Servicio</dt><dd>{formatCop(checkout.baseFeeMinor, checkout.currency)}</dd></div>
        <div><dt>Entrega</dt><dd>{formatCop(checkout.deliveryFeeMinor, checkout.currency)}</dd></div>
        <div className="price-total">
          <dt>Total calculado por el API</dt>
          <dd>{formatCop(checkout.totalAmountInMinorUnits, checkout.currency)}</dd>
        </div>
      </dl>

      <div className="delivery-summary">
        <div className="summary-icon" aria-hidden="true">⌖</div>
        <div>
          <strong>Entrega</strong>
          {redacted ? (
            <p>Los datos personales se eliminan después del periodo de retención de 30 días.</p>
          ) : (
            <p>
              {checkout.delivery.recipient}<br />
              {checkout.delivery.address}
            </p>
          )}
        </div>
      </div>

      <div className="reservation-summary">
        <span className="reservation-dot" aria-hidden="true" />
        <div>
          <strong>
            {checkout.reservation.state === 'HELD'
              ? 'Unidades apartadas para ti'
              : checkout.reservation.state === 'COMMITTED'
                ? 'Inventario confirmado'
                : 'Reserva liberada'}
          </strong>
          <p>
            {checkout.reservation.state === 'HELD'
              ? `La reserva vence ${formatDateTime(checkout.reservation.expiresAt)}.`
              : `Checkout creado ${formatDateTime(checkout.createdAt)}.`}
          </p>
        </div>
      </div>
    </aside>
  );
}
