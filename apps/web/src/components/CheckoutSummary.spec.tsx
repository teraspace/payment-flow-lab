import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { CheckoutSummary } from './CheckoutSummary';
import { makeCheckout } from '../test-fixtures';

describe('CheckoutSummary', () => {
  it('shows server totals, delivery details, and held inventory', async () => {
    const { container } = render(<CheckoutSummary checkout={makeCheckout()} />);
    expect(screen.getByText('Inventario reservado')).toBeInTheDocument();
    expect(screen.getByText('Total calculado por el API')).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText('Unidades apartadas para ti')).toBeInTheDocument();
    expect(screen.getByText(/La reserva vence/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('redacts delivery when the retained name is missing and uses fallback product art', () => {
    const { container } = render(
      <CheckoutSummary
        checkout={makeCheckout({
          customer: { fullName: null, email: 'ada@example.test' },
          delivery: { recipient: null, address: null },
          item: { ...makeCheckout().item, sku: 'future-product', quantity: 2 },
          reservation: { state: 'COMMITTED', expiresAt: '2026-10-01T12:00:00.000Z' },
        })}
      />,
    );
    expect(screen.getByText(/Los datos personales se eliminan/)).toBeInTheDocument();
    expect(screen.getByText('Inventario confirmado')).toBeInTheDocument();
    expect(screen.getByText('2 unidades')).toBeInTheDocument();
    expect(screen.getByText(/Checkout creado/)).toBeInTheDocument();
    expect(container.querySelector('.summary-item-art img')).toHaveAttribute('src', '/catalog/notebook.svg');
  });

  it('redacts delivery when the retained email is missing and reports released inventory', () => {
    render(
      <CheckoutSummary
        checkout={makeCheckout({
          customer: { fullName: 'Ada Lovelace', email: null },
          reservation: { state: 'RELEASED', expiresAt: 'invalid-date' },
          createdAt: 'invalid-date',
          state: 'UNKNOWN_OUTCOME',
        })}
      />,
    );
    expect(screen.getByText('Resultado por conciliar')).toBeInTheDocument();
    expect(screen.getByText('Reserva liberada')).toBeInTheDocument();
    expect(screen.getByText(/Checkout creado Fecha no disponible/)).toBeInTheDocument();
    expect(screen.getByText(/Los datos personales se eliminan/)).toBeInTheDocument();
  });

  it.each([
    ['RESERVED', 'Inventario reservado'],
    ['PAYMENT_PENDING', 'Pago en proceso'],
    ['UNKNOWN_OUTCOME', 'Resultado por conciliar'],
    ['PAYMENT_FAILED', 'Pago sin aprobar'],
    ['PAID', 'Pedido confirmado'],
    ['CANCEL_PENDING', 'Anulación en proceso'],
    ['CANCELLED', 'Pedido cancelado'],
    ['EXPIRED', 'Reserva vencida'],
    ['FULFILLMENT_EXCEPTION', 'Pedido en revisión'],
  ] as const)('labels checkout state %s', (state, label) => {
    render(<CheckoutSummary checkout={makeCheckout({ state })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
