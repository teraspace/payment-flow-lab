jest.mock('./app/service-api', () => ({
  useCreateCheckoutMutation: jest.fn(),
  useGetCheckoutQuery: jest.fn(),
  useGetLatestPaymentAttemptQuery: jest.fn(),
  useGetProductsQuery: jest.fn(),
  useGetReadinessQuery: jest.fn(),
  useInitializeGuestSessionMutation: jest.fn(),
  useRecoverCheckoutMutation: jest.fn(),
}));

jest.mock('./components/PaymentPanel', () => ({
  PaymentPanel: ({ canStartAttempt }: { canStartAttempt: boolean }) => {
    const { createElement } = jest.requireActual<typeof import('react')>('react');
    return createElement('div', {
      'data-testid': 'payment-panel',
      'data-can-start': String(canStartAttempt),
    });
  },
}));

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import * as serviceApi from './app/service-api';
import { App } from './App';
import { makeAttempt, makeCheckout, makeProduct } from './test-fixtures';

type Scene = {
  productQuery: Record<string, unknown>;
  checkoutQuery: Record<string, unknown>;
  attemptQuery: Record<string, unknown>;
};

let scene: Scene;
let initializeGuestSession: jest.Mock;
let createCheckout: jest.Mock;
let recoverCheckout: jest.Mock;
let resetCheckoutCreation: jest.Mock;
let resetCheckoutRecovery: jest.Mock;
let refetchCheckout: jest.Mock;
let refetchAttempt: jest.Mock;
let refetchProducts: jest.Mock;

function configureHooks() {
  const hooks = serviceApi as unknown as Record<string, jest.Mock>;
  hooks.useInitializeGuestSessionMutation.mockReturnValue([
    initializeGuestSession,
    { isSuccess: true, isError: false },
  ]);
  hooks.useCreateCheckoutMutation.mockReturnValue([
    createCheckout,
    { isLoading: false, reset: resetCheckoutCreation },
  ]);
  hooks.useRecoverCheckoutMutation.mockReturnValue([
    recoverCheckout,
    { reset: resetCheckoutRecovery },
  ]);
  hooks.useGetReadinessQuery.mockReturnValue({ data: { status: 'ok' }, isFetching: false });
  hooks.useGetProductsQuery.mockImplementation(() => scene.productQuery);
  hooks.useGetCheckoutQuery.mockImplementation(() => ({ refetch: refetchCheckout, ...scene.checkoutQuery }));
  hooks.useGetLatestPaymentAttemptQuery.mockImplementation(() => ({ refetch: refetchAttempt, ...scene.attemptQuery }));
}

function fillDeliveryForm(user: ReturnType<typeof userEvent.setup>) {
  return (async () => {
    await user.type(screen.getByLabelText('Nombre completo'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Correo electrónico'), 'ada@example.test');
    await user.type(screen.getByLabelText('Persona que recibe'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Dirección completa'), 'Calle 1 #2-3');
  })();
}

describe('App purchase flow', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
    scene = {
      productQuery: { data: [makeProduct()], isLoading: false, isError: false },
      checkoutQuery: { data: undefined, isLoading: false, isError: false },
      attemptQuery: { data: undefined, isLoading: false, isError: true, error: { status: 404 } },
    };
    initializeGuestSession = jest.fn(() => ({ unwrap: () => Promise.resolve({ expiresAt: '' }) }));
    createCheckout = jest.fn(() => ({ unwrap: () => Promise.resolve(makeCheckout()) }));
    recoverCheckout = jest.fn(() => ({ unwrap: () => Promise.resolve(makeCheckout()) }));
    resetCheckoutCreation = jest.fn();
    resetCheckoutRecovery = jest.fn();
    refetchCheckout = jest.fn().mockResolvedValue({});
    refetchAttempt = jest.fn().mockResolvedValue({});
    refetchProducts = jest.fn().mockResolvedValue({});
    scene.productQuery.refetch = refetchProducts;
    configureHooks();
  });

  it('starts a guest session and presents the product catalog', async () => {
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Compra algo que te guste.' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('API conectado');
    expect(initializeGuestSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('navigation', { name: 'Progreso de compra' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('reserves catalog space while the guest session is initializing', () => {
    const hooks = serviceApi as unknown as Record<string, jest.Mock>;
    hooks.useInitializeGuestSessionMutation.mockReturnValue([
      initializeGuestSession,
      { isSuccess: false, isError: false, isLoading: true },
    ]);
    render(<App />);
    expect(screen.getByRole('status', { name: 'Iniciando sesión segura' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Compra algo que te guste.' })).toBeInTheDocument();
  });

  it('shows guest-session failures and retries without hiding a readiness check', async () => {
    const user = userEvent.setup();
    const hooks = serviceApi as unknown as Record<string, jest.Mock>;
    hooks.useInitializeGuestSessionMutation.mockReturnValue([
      initializeGuestSession,
      { isSuccess: false, isError: true, error: { data: { message: 'Cookie de sesión rechazada' } } },
    ]);
    hooks.useGetReadinessQuery.mockReturnValue({ isFetching: true, error: { status: 503 } });
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('Cookie de sesión rechazada');
    expect(screen.getByText('Conectando API')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar conexión' }));
    expect(initializeGuestSession).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an idle unavailable API from an API still connecting', () => {
    const hooks = serviceApi as unknown as Record<string, jest.Mock>;
    hooks.useGetReadinessQuery.mockReturnValue({ isFetching: false, error: new Error('offline') });
    render(<App />);
    expect(screen.getByText('API no disponible')).toBeInTheDocument();
  });

  it('selects a product and creates a checkout from the entered details', async () => {
    const user = userEvent.setup();
    const checkout = makeCheckout();
    createCheckout = jest.fn(() => ({ unwrap: () => Promise.resolve(checkout) }));
    configureHooks();
    scene.checkoutQuery = { data: checkout, isLoading: false, isError: false };
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Elegir producto/ }));
    expect(screen.getByRole('heading', { name: '¿A dónde lo enviamos?' })).toBeInTheDocument();
    await fillDeliveryForm(user);
    window.sessionStorage.setItem('pfl.checkout-command.v1', 'checkout-command-reused-01');
    jest.spyOn(window.sessionStorage.__proto__, 'removeItem').mockImplementation(() => {
      throw new Error('storage cleanup denied');
    });
    await user.click(screen.getByRole('button', { name: /Revisar y continuar/ }));
    expect(await screen.findByTestId('payment-panel')).toHaveAttribute('data-can-start', 'true');
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'checkout-command-reused-01',
      body: {
        productId: 'product-1', quantity: 1,
        customer: { fullName: 'Ada Lovelace', email: 'ada@example.test' },
        delivery: { recipient: 'Ada Lovelace', address: 'Calle 1 #2-3' },
      },
    }));
    expect(window.location.search).toContain(checkout.checkoutId);
    expect(window.sessionStorage.getItem('pfl.checkout-command.v1')).toBe('checkout-command-reused-01');
    expect(resetCheckoutCreation).toHaveBeenCalled();
  });

  it('recovers after an ambiguous checkout-creation response with the same command key', async () => {
    const user = userEvent.setup();
    const recovered = makeCheckout({ checkoutId: 'e16f63ce-72f2-4d1f-a183-92280f91d7ec' });
    createCheckout = jest.fn(() => ({ unwrap: () => Promise.reject(new Error('network timeout')) }));
    recoverCheckout = jest.fn(() => ({ unwrap: () => Promise.resolve(recovered) }));
    scene.checkoutQuery = { data: recovered, isLoading: false, isError: false };
    configureHooks();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Elegir producto/ }));
    await fillDeliveryForm(user);
    await user.click(screen.getByRole('button', { name: /Revisar y continuar/ }));
    await screen.findByTestId('payment-panel');
    expect(recoverCheckout).toHaveBeenCalledWith(expect.any(String));
    expect(resetCheckoutRecovery).toHaveBeenCalled();
  });

  it.each([
    [410, 'La clave anterior venció. Vuelve a enviar los datos para iniciar una reserva nueva.'],
    [404, 'Puedes reintentar: la misma clave evita reservar dos veces.'],
    [503, 'No pudimos confirmar la reserva. Conservamos la clave; vuelve a consultar o reintenta con los mismos datos.'],
  ])('keeps the checkout form safe when creation and recovery return %s', async (status, message) => {
    const user = userEvent.setup();
    createCheckout = jest.fn(() => ({ unwrap: () => Promise.reject(new Error('Creation failed')) }));
    recoverCheckout = jest.fn(() => ({ unwrap: () => Promise.reject({ status }) }));
    configureHooks();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Elegir producto/ }));
    await fillDeliveryForm(user);
    await user.click(screen.getByRole('button', { name: /Revisar y continuar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('heading', { name: '¿A dónde lo enviamos?' })).toBeInTheDocument();
  });

  it('does not send a checkout when session storage cannot persist an idempotency key', async () => {
    const user = userEvent.setup();
    jest.spyOn(window.sessionStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Elegir producto/ }));
    await fillDeliveryForm(user);
    await user.click(screen.getByRole('button', { name: /Revisar y continuar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no enviamos la reserva');
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it('recovers a persisted checkout command after reload', async () => {
    window.sessionStorage.setItem('pfl.checkout-command.v1', 'checkout-command-000001');
    const recovered = makeCheckout({ checkoutId: 'e16f63ce-72f2-4d1f-a183-92280f91d7ec' });
    recoverCheckout = jest.fn(() => ({ unwrap: () => Promise.resolve(recovered) }));
    scene.checkoutQuery = { data: recovered, isLoading: false, isError: false };
    configureHooks();
    render(<App />);
    expect(await screen.findByTestId('payment-panel')).toBeInTheDocument();
    expect(recoverCheckout).toHaveBeenCalledWith('checkout-command-000001');
    expect(window.sessionStorage.getItem('pfl.checkout-command.v1')).toBeNull();
  });

  it.each([
    [410, 'La clave de recuperación superó el periodo de retención.'],
    [404, 'Aún no aparece una reserva para el último comando.'],
    [503, 'No pudimos consultar la reserva anterior.'],
  ])('explains command recovery response %s', async (status, message) => {
    window.sessionStorage.setItem('pfl.checkout-command.v1', 'checkout-command-000001');
    recoverCheckout = jest.fn(() => ({ unwrap: () => Promise.reject({ status }) }));
    configureHooks();
    render(<App />);
    expect(await screen.findByText(new RegExp(message.slice(0, 16)))).toBeInTheDocument();
    expect(resetCheckoutRecovery).toHaveBeenCalled();
  });

  it('lets the customer dismiss recovery feedback and retry catalog loading', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('pfl.checkout-command.v1', 'checkout-command-000001');
    recoverCheckout = jest.fn(() => ({ unwrap: () => Promise.reject({ status: 404 }) }));
    scene.productQuery = { isLoading: false, isError: true, error: new Error('API no disponible'), refetch: refetchProducts };
    configureHooks();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Entendido' }));
    expect(screen.queryByText(/Aún no aparece una reserva/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(refetchProducts).toHaveBeenCalledTimes(1);
  });

  it('handles invalid and unavailable checkout links and returns to catalog', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/?checkout=bad-id');
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('El enlace del checkout no es válido.');
    await user.click(screen.getByRole('button', { name: 'Ir al catálogo' }));
    expect(await screen.findByRole('heading', { name: 'Compra algo que te guste.' })).toBeInTheDocument();
    expect(window.location.search).toBe('');

    window.history.replaceState(null, '', '/?checkout=a745095c-4932-4cdb-a1d3-2e30f81e380b');
    scene.checkoutQuery = { data: undefined, isLoading: false, isError: true, error: { status: 503 } };
    configureHooks();
    const { rerender } = render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('Revisa la conexión y vuelve a consultar el pedido.');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(refetchCheckout).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Volver al catálogo' }));
    expect(window.location.search).toBe('');
    rerender(<App />);
  });

  it('shows the pending state while a persisted checkout is being loaded', () => {
    window.history.replaceState(null, '', '/?checkout=a745095c-4932-4cdb-a1d3-2e30f81e380b');
    scene.checkoutQuery = { data: undefined, isLoading: true, isError: false };
    configureHooks();
    render(<App />);
    expect(screen.getByText('Validando la reserva con el API…')).toBeInTheDocument();
  });

  it('uses a server-provided checkout error and keeps the active checkout from being discarded by the brand link', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/?checkout=a745095c-4932-4cdb-a1d3-2e30f81e380b');
    scene.checkoutQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 422, data: { message: 'La reserva venció' } },
    };
    configureHooks();
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('La reserva venció');
    const brand = screen.getByRole('link', { name: /Payment Flow Lab/ });
    expect(brand).toHaveAttribute('aria-disabled', 'true');
    await user.click(brand);
    expect(window.location.search).toContain('checkout=a745095c-4932-4cdb-a1d3-2e30f81e380b');
  });

  it('lets the brand link clear an invalid checkout URL', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/?checkout=bad-id');
    render(<App />);
    await user.click(screen.getByRole('link', { name: /Payment Flow Lab/ }));
    expect(await screen.findByRole('heading', { name: 'Compra algo que te guste.' })).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('maps payment query states and only enables safe retries', async () => {
    const cases = [
      [makeCheckout(), undefined, true],
      [makeCheckout({ state: 'PAID' }), undefined, false],
      [makeCheckout({ reservation: { state: 'RELEASED', expiresAt: '2026-10-01T12:00:00.000Z' } }), undefined, false],
      [makeCheckout(), makeAttempt({ state: 'UNKNOWN_OUTCOME' }), false],
      [makeCheckout({ state: 'PAYMENT_FAILED' }), makeAttempt({ state: 'DECLINED', attemptNumber: 1 }), true],
      [makeCheckout(), makeAttempt({ state: 'DECLINED', attemptNumber: 2 }), false],
      [makeCheckout(), makeAttempt({ state: 'FAILED_LOCAL', attemptNumber: 9 }), true],
      [makeCheckout(), makeAttempt({ state: 'FAILED_LOCAL', attemptNumber: 10 }), false],
    ] as const;
    for (const [checkout, attempt, allowed] of cases) {
      window.history.replaceState(null, '', `/?checkout=${checkout.checkoutId}`);
      scene.checkoutQuery = { data: checkout, isLoading: false, isError: false };
      scene.attemptQuery = attempt
        ? { data: attempt, isLoading: false, isError: false, isSuccess: true }
        : { data: undefined, isLoading: false, isError: true, error: { status: 404 }, isSuccess: false };
      configureHooks();
      const { unmount } = render(<App />);
      await waitFor(() => expect(screen.getByTestId('payment-panel')).toHaveAttribute('data-can-start', String(allowed)));
      unmount();
    }
  });

  it('shows API error details and refreshes checkout and payment in parallel', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/?checkout=a745095c-4932-4cdb-a1d3-2e30f81e380b');
    scene.checkoutQuery = { data: makeCheckout(), isLoading: false, isError: false };
    scene.attemptQuery = { data: undefined, isLoading: false, isError: true, error: { status: 500 } };
    configureHooks();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Actualizar el estado del pedido' }));
    expect(refetchCheckout).toHaveBeenCalledTimes(1);
    expect(refetchAttempt).toHaveBeenCalledTimes(1);
  });
});
