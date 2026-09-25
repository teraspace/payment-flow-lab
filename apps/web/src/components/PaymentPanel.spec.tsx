jest.mock('../app/service-api', () => ({
  ApiRequestError: jest.requireActual('../app/service-api').ApiRequestError,
  submitPaymentAttempt: jest.fn(),
}));

jest.mock('../app/sandbox-payment', () => ({
  getSandboxPaymentConfiguration: jest.fn(),
}));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  ApiRequestError,
  submitPaymentAttempt,
} from '../app/service-api';
import { getSandboxPaymentConfiguration } from '../app/sandbox-payment';
import { PaymentPanel } from './PaymentPanel';
import { makeAttempt, makeCheckout } from '../test-fixtures';

const acceptance = {
  acceptanceToken: 'accept-token',
  acceptanceUrl: 'https://provider.example.test/terms',
  personalDataAuthorizationToken: 'privacy-token',
  personalDataAuthorizationUrl: 'https://provider.example.test/privacy',
};

const mockSubmitAttempt = jest.mocked(submitPaymentAttempt);
const mockGetConfiguration = jest.mocked(getSandboxPaymentConfiguration);

function renderPanel(props: Partial<React.ComponentProps<typeof PaymentPanel>> = {}) {
  return render(
    <PaymentPanel
      attemptLookupState="not-found"
      canStartAttempt
      checkout={makeCheckout()}
      paymentToken="tok_test_opaque"
      paymentAcceptance={acceptance}
      onRequestCard={jest.fn()}
      onPaymentTokenUsed={jest.fn()}
      onAttemptResult={jest.fn()}
      onRefreshAttempt={jest.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  );
}

describe('PaymentPanel', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    window.sessionStorage.clear();
    mockGetConfiguration.mockReturnValue({ ready: true, configuration: { environment: 'test' } });
    mockSubmitAttempt.mockResolvedValue(makeAttempt({ state: 'APPROVED' }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('requires the in-memory token and acceptance before enabling payment', async () => {
    const user = userEvent.setup();
    const onRequestCard = jest.fn();
    const { container } = renderPanel({ paymentToken: null, paymentAcceptance: null, onRequestCard });
    expect(screen.getByText('Tarjeta y autorización requeridas')).toBeInTheDocument();
    const payButton = screen.getByRole('button', { name: /Pagar/ });
    expect(payButton).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Ingresar tarjeta' }));
    expect(onRequestCard).toHaveBeenCalledTimes(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('submits the in-memory sandbox token, consent values, and installments', async () => {
    const user = userEvent.setup();
    const refresh = jest.fn().mockResolvedValue(undefined);
    const result = makeAttempt({ state: 'APPROVED', attemptNumber: 1 });
    mockSubmitAttempt.mockResolvedValue(result);
    renderPanel({ onRefreshAttempt: refresh });
    await screen.findByText('Tarjeta ficticia tokenizada para sandbox.');
    await user.selectOptions(screen.getByLabelText('¿En cuántas cuotas quieres pagar?'), '3');
    await user.click(screen.getByRole('button', { name: /Pagar/ }));
    await waitFor(() => expect(mockSubmitAttempt).toHaveBeenCalledWith(
      makeCheckout().checkoutId,
      expect.any(String),
      {
        paymentToken: 'tok_test_opaque',
        acceptanceToken: 'accept-token',
        personalDataAuthorizationToken: 'privacy-token',
        installments: 3,
      },
    ));
    expect(await screen.findByText('Pago aprobado en sandbox')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(`pfl.payment-recovery.v1:${makeCheckout().checkoutId}`)).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('fails closed if acceptance data is missing', async () => {
    const { container } = renderPanel({ paymentAcceptance: null });
    await screen.findByText('Tarjeta ficticia tokenizada para sandbox.');
    const form = container.querySelector('form.payment-form')!;
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent('El pago sandbox no está listo');
    expect(mockSubmitAttempt).not.toHaveBeenCalled();
  });

  it('asks for a fresh sandbox token after refresh without submitting a payment', async () => {
    const user = userEvent.setup();
    const onRequestCard = jest.fn();
    renderPanel({ paymentToken: null, paymentAcceptance: null, onRequestCard });
    await screen.findByText('Tarjeta y autorización requeridas');
    expect(screen.getByRole('button', { name: /Pagar/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Ingresar tarjeta' }));
    expect(onRequestCard).toHaveBeenCalledTimes(1);
    expect(mockSubmitAttempt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(`pfl.payment-recovery.v1:${makeCheckout().checkoutId}`)).toBeNull();
  });

  it('treats a payment API timeout as unknown and asks the user to reconcile, never resend', async () => {
    const user = userEvent.setup();
    const refresh = jest.fn().mockResolvedValue(undefined);
    mockSubmitAttempt.mockRejectedValue(new ApiRequestError(504, 'API timeout'));
    renderPanel({ onRefreshAttempt: refresh });
    await screen.findByText('Tarjeta ficticia tokenizada para sandbox.');
    await user.click(screen.getByRole('button', { name: /Pagar/ }));
    expect(await screen.findByText('Estamos recuperando el resultado.')).toBeInTheDocument();
    expect(screen.getByText(/No vuelvas a enviar el pago/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pagar/ })).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the payment gateway is not in sandbox', () => {
    mockGetConfiguration.mockReturnValue({
      ready: false,
      message: 'Ambiente no permitido',
    });
    renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('El pago está deshabilitado');
    expect(screen.getByText('No se aceptan tarjetas reales ni se crean cobros reales en esta aplicación.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Número de tarjeta de prueba')).not.toBeInTheDocument();
  });

  it('blocks payment when attempt status cannot be checked and offers a safe refresh', async () => {
    const user = userEvent.setup();
    const refresh = jest.fn().mockResolvedValue(undefined);
    renderPanel({ attemptLookupState: 'error', canStartAttempt: false, onRefreshAttempt: refresh });
    expect(screen.getByRole('alert')).toHaveTextContent('formulario permanece bloqueado');
    await user.click(screen.getByRole('button', { name: 'Consultar de nuevo' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows all persisted payment outcomes with an appropriate status message', () => {
    const states = [
      ['CREATED', 'Preparando el intento'],
      ['DISPATCHING', 'Pago en proceso'],
      ['FAILED_LOCAL', 'El pago no salió del sistema'],
      ['REJECTED_NO_TRANSACTION', 'El sandbox rechazó la solicitud'],
      ['PENDING', 'Pago pendiente de confirmación'],
      ['UNKNOWN_OUTCOME', 'Estamos conciliando el resultado'],
      ['APPROVED', 'Pago aprobado en sandbox'],
      ['DECLINED', 'Pago de prueba rechazado'],
      ['ERROR', 'El sandbox devolvió un error'],
      ['VOIDED', 'Pago anulado'],
    ] as const;
    for (const [state, title] of states) {
      const { unmount } = renderPanel({ attempt: makeAttempt({ state }) });
      expect(screen.getByText(title)).toBeInTheDocument();
      unmount();
    }
  });

  it('keeps a retry behind manual-review and unknown-outcome guards', async () => {
    const user = userEvent.setup();
    const refresh = jest.fn().mockResolvedValue(undefined);
    const { rerender } = renderPanel({
      attempt: makeAttempt({ state: 'UNKNOWN_OUTCOME', manualReviewRequired: true }),
      onRefreshAttempt: refresh,
    });
    expect(screen.getByText('El intento requiere revisión.')).toBeInTheDocument();
    expect(screen.getByText('El resultado todavía no está confirmado.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Número de tarjeta de prueba')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    expect(refresh).toHaveBeenCalled();
    rerender(
      <PaymentPanel
        attempt={makeAttempt({ state: 'DECLINED' })}
        attemptLookupState="found"
        canStartAttempt
        checkout={makeCheckout()}
        paymentToken="tok_test_opaque"
        paymentAcceptance={acceptance}
        onRequestCard={jest.fn()}
        onPaymentTokenUsed={jest.fn()}
        onAttemptResult={jest.fn()}
        onRefreshAttempt={refresh}
      />,
    );
    expect(screen.getByText(/Puedes hacer un único intento adicional/)).toBeInTheDocument();
  });

  it('recovers a recent attempt marker and refreshes once before the recovery window closes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    const refresh = jest.fn().mockResolvedValue(undefined);
    const checkoutId = makeCheckout().checkoutId;
    window.sessionStorage.setItem(`pfl.payment-recovery.v1:${checkoutId}`, String(Date.now() - 9_000));
    renderPanel({ attemptLookupState: 'not-found', canStartAttempt: false, onRefreshAttempt: refresh });
    expect(screen.getByText('Estamos recuperando el resultado.')).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTimeAsync(1_100));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(`pfl.payment-recovery.v1:${checkoutId}`)).not.toBeNull();
  });

  it('clears an invalid recovery marker and guards session storage failures', () => {
    const checkoutId = makeCheckout().checkoutId;
    window.sessionStorage.setItem(`pfl.payment-recovery.v1:${checkoutId}`, 'not-a-timestamp');
    renderPanel({ attemptLookupState: 'not-found', canStartAttempt: true });
    expect(screen.queryByText('Estamos recuperando el resultado.')).not.toBeInTheDocument();
    jest.spyOn(window.sessionStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });
    expect(() => renderPanel({ attemptLookupState: 'not-found', canStartAttempt: false })).not.toThrow();
  });

  it('clears a recovery marker after the reconciliation window elapses', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    const checkoutId = makeCheckout().checkoutId;
    window.sessionStorage.setItem(`pfl.payment-recovery.v1:${checkoutId}`, String(Date.now() - 11_000));
    renderPanel({ attemptLookupState: 'not-found', canStartAttempt: true });
    expect(screen.getByText('Estamos recuperando el resultado.')).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(window.sessionStorage.getItem(`pfl.payment-recovery.v1:${checkoutId}`)).toBeNull();
    expect(screen.queryByText('Estamos recuperando el resultado.')).not.toBeInTheDocument();
  });

  it('polls unresolved attempts only while the document is visible', async () => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const refresh = jest.fn().mockResolvedValue(undefined);
    renderPanel({ attempt: makeAttempt({ state: 'PENDING' }), attemptLookupState: 'found', onRefreshAttempt: refresh });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the retry explanation when a failed-local attempt can safely be repeated', () => {
    renderPanel({ attempt: makeAttempt({ state: 'FAILED_LOCAL' }), attemptLookupState: 'found' });
    expect(screen.getByText(/El último intento no llegó al procesador/)).toBeInTheDocument();
  });
});
