import { skipToken } from '@reduxjs/toolkit/query';
import { useCallback, useEffect, useState } from 'react';
import {
  useCreateCheckoutMutation,
  useGetCheckoutQuery,
  useGetLatestPaymentAttemptQuery,
  useGetProductsQuery,
  useGetReadinessQuery,
  useInitializeGuestSessionMutation,
  useRecoverCheckoutMutation,
  type Checkout,
  type Product,
} from './app/service-api';
import { CheckoutDetailsForm } from './components/CheckoutDetailsForm';
import { CheckoutSummary } from './components/CheckoutSummary';
import { PaymentPanel } from './components/PaymentPanel';
import { ProductCatalog } from './components/ProductCatalog';

const CHECKOUT_COMMAND_KEY = 'pfl.checkout-command.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ApiStatus() {
  const { data, error, isFetching } = useGetReadinessQuery();
  const ready = data?.status === 'ok';

  return (
    <div className={`api-status ${ready ? 'api-status--ready' : 'api-status--waiting'}`} role="status" aria-live="polite">
      <span className="api-status-dot" aria-hidden="true" />
      <span>{ready ? 'API conectado' : isFetching ? 'Conectando API' : error ? 'API no disponible' : 'Esperando API'}</span>
    </div>
  );
}

export function App() {
  const [initializeGuestSession, sessionInitialization] = useInitializeGuestSessionMutation();
  const [createCheckout, { isLoading: checkoutCreating, reset: resetCheckoutCreation }] = useCreateCheckoutMutation();
  const [recoverCheckout, { reset: resetCheckoutRecovery }] = useRecoverCheckoutMutation();
  const [checkoutId, setCheckoutId] = useState<string | null>(() => readCheckoutId());
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(() =>
    readCheckoutId() !== null || hasInvalidCheckoutId() || readCheckoutCommandKey() === null,
  );
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [invalidCheckoutLink, setInvalidCheckoutLink] = useState(hasInvalidCheckoutId);

  const sessionReady = sessionInitialization.isSuccess;
  const checkoutQuery = useGetCheckoutQuery(
    sessionReady && checkoutId ? checkoutId : skipToken,
  );
  const paymentAttemptQuery = useGetLatestPaymentAttemptQuery(
    sessionReady && checkoutId ? checkoutId : skipToken,
  );
  const refetchCheckout = checkoutQuery.refetch;
  const refetchLatestPaymentAttempt = paymentAttemptQuery.refetch;
  const productsQuery = useGetProductsQuery(undefined, {
    skip: !sessionReady || Boolean(checkoutId) || !recoveryChecked,
  });

  useEffect(() => {
    void initializeGuestSession().unwrap().catch(() => undefined);
  }, [initializeGuestSession]);

  const openCheckout = useCallback((id: string) => {
    setCheckoutId(id);
    setSelectedProduct(null);
    setRecoveryMessage(null);
    setCheckoutError(null);
    setRecoveryChecked(true);
    const url = new URL(window.location.href);
    url.searchParams.set('checkout', id);
    window.history.replaceState(null, '', url);
  }, []);

  const browseCatalog = useCallback(() => {
    setCheckoutId(null);
    setSelectedProduct(null);
    setRecoveryMessage(null);
    setCheckoutError(null);
    setInvalidCheckoutLink(false);
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    window.history.replaceState(null, '', url);
  }, []);

  useEffect(() => {
    if (!sessionReady || checkoutId || recoveryChecked) return;
    const commandKey = readCheckoutCommandKey();
    if (!commandKey) return;

    let active = true;
    recoverCheckout(commandKey)
      .unwrap()
      .then((checkout) => {
        if (!active) return;
        clearCheckoutCommandKey();
        openCheckout(checkout.checkoutId);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const status = getErrorStatus(error);
        if (status === 410) {
          clearCheckoutCommandKey();
          setRecoveryMessage(
            'La clave de recuperación superó el periodo de retención. Puedes iniciar un checkout nuevo.',
          );
        } else if (status === 404) {
          setRecoveryMessage(
            'Aún no aparece una reserva para el último comando. Conservamos su clave para que un nuevo envío no cree reservas duplicadas.',
          );
        } else {
          setRecoveryMessage(
            'No pudimos consultar la reserva anterior. Vuelve a intentarlo antes de iniciar otra.',
          );
        }
        setRecoveryChecked(true);
      })
      .finally(() => resetCheckoutRecovery());

    return () => {
      active = false;
    };
  }, [
    checkoutId,
    openCheckout,
    recoverCheckout,
    recoveryChecked,
    resetCheckoutRecovery,
    sessionReady,
  ]);

  const refreshCheckoutAndAttempt = useCallback(async () => {
    if (!checkoutId) return;
    await Promise.allSettled([
      refetchCheckout(),
      refetchLatestPaymentAttempt(),
    ]);
  }, [checkoutId, refetchCheckout, refetchLatestPaymentAttempt]);

  async function submitCheckout(details: {
    productId: string;
    quantity: number;
    customer: { fullName: string; email: string };
    delivery: { recipient: string; address: string };
  }) {
    setCheckoutError(null);
    const commandKey = createOrReadCheckoutCommandKey();
    if (!commandKey) {
      setCheckoutError(
        'El navegador no permite guardar una clave de recuperación temporal; no enviamos la reserva.',
      );
      return;
    }

    try {
      const checkout = await createCheckout({
        idempotencyKey: commandKey,
        body: details,
      }).unwrap();
      resetCheckoutCreation();
      clearCheckoutCommandKey();
      openCheckout(checkout.checkoutId);
    } catch (error) {
      resetCheckoutCreation();
      try {
        const recovered = await recoverCheckout(commandKey).unwrap();
        resetCheckoutRecovery();
        clearCheckoutCommandKey();
        openCheckout(recovered.checkoutId);
      } catch (recoveryError) {
        resetCheckoutRecovery();
        if (getErrorStatus(recoveryError) === 410) {
          clearCheckoutCommandKey();
          setCheckoutError('La clave anterior venció. Vuelve a enviar los datos para iniciar una reserva nueva.');
        } else if (getErrorStatus(recoveryError) === 404) {
          setCheckoutError(
            `${getErrorMessage(error, 'No pudimos confirmar la reserva.')} Puedes reintentar: la misma clave evita reservar dos veces.`,
          );
        } else {
          setCheckoutError(
            'No pudimos confirmar la reserva. Conservamos la clave; vuelve a consultar o reintenta con los mismos datos.',
          );
        }
      }
    }
  }

  const routeIsInvalid = invalidCheckoutLink && !checkoutId;
  const activeStep = checkoutId ? 3 : selectedProduct ? 2 : 1;
  const checkout = checkoutQuery.data;
  const latestAttempt = paymentAttemptQuery.data;
  const attemptLookupState = paymentAttemptQuery.isSuccess
    ? 'found'
    : paymentAttemptQuery.isError && getErrorStatus(paymentAttemptQuery.error) === 404
      ? 'not-found'
      : paymentAttemptQuery.isError
        ? 'error'
        : 'loading';
  const canStartAttempt = Boolean(
    checkout &&
    ['found', 'not-found'].includes(attemptLookupState) &&
    canPayAgain(checkout, latestAttempt),
  );

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <header className="topbar">
        <a
          aria-disabled={checkoutId ? true : undefined}
          className="wordmark"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            if (!checkoutId) browseCatalog();
          }}
          tabIndex={checkoutId ? -1 : undefined}
        >
          <span className="wordmark-mark" aria-hidden="true">P</span>
          <span>Payment Flow Lab</span>
        </a>
        <div className="topbar-actions">
          <ApiStatus />
          <span className="secure-label"><span aria-hidden="true">◈</span> Sandbox protegido</span>
        </div>
      </header>

      <main className="page-shell" id="main-content">
        <div className="page-intro">
          <div>
            <p className="eyebrow">Checkout engineering challenge</p>
            <h1>Una compra clara, de principio a fin.</h1>
            <p className="page-description">
              Reserva de inventario, resumen calculado por el servidor y pago de prueba con recuperación segura.
            </p>
          </div>
          <div className="intro-decoration" aria-hidden="true">
            <span className="intro-decoration-ring" />
            <span className="intro-decoration-dot" />
            <span className="intro-decoration-line" />
          </div>
        </div>

        <CheckoutProgress activeStep={activeStep} />

        {!sessionReady && sessionInitialization.isError ? (
          <div className="large-message" role="alert" aria-live="polite">
            <span className="loading-mark" aria-hidden="true" />
            <div>
              <strong>{sessionInitialization.isError ? 'No pudimos iniciar la sesión.' : 'Preparando tu checkout…'}</strong>
              <p>
                {sessionInitialization.isError
                  ? getErrorMessage(sessionInitialization.error, 'Revisa que el API esté disponible e inténtalo de nuevo.')
                  : 'La sesión anónima permite recuperar tu pedido sin crear una cuenta.'}
              </p>
              {sessionInitialization.isError ? (
                <button className="button button--secondary" onClick={() => void initializeGuestSession()} type="button">
                  Reintentar conexión
                </button>
              ) : null}
            </div>
          </div>
        ) : !sessionReady ? (
          <ProductCatalog
            isLoading
            loadingLabel="Iniciando sesión segura"
            onRetry={() => void productsQuery.refetch()}
            onSelect={() => undefined}
            products={[]}
          />
        ) : routeIsInvalid ? (
          <div className="large-message message-card--error" role="alert">
            <div>
              <strong>El enlace del checkout no es válido.</strong>
              <p>Abre el catálogo para iniciar un pedido nuevo.</p>
            </div>
            <button className="button button--primary" onClick={browseCatalog} type="button">Ir al catálogo</button>
          </div>
        ) : !recoveryChecked ? (
          <div className="large-message" role="status" aria-live="polite">
            <span className="loading-mark" aria-hidden="true" />
            <div>
              <strong>Recuperando tu pedido…</strong>
              <p>Consultamos el API con la clave temporal; no guardamos los datos personales en el navegador.</p>
            </div>
          </div>
        ) : checkoutId ? (
          checkoutQuery.isError && !checkout ? (
            <div className="large-message message-card--error" role="alert">
              <div>
                <strong>No pudimos abrir este checkout.</strong>
                <p>{getErrorMessage(checkoutQuery.error, 'Revisa la conexión y vuelve a consultar el pedido.')}</p>
              </div>
              <div className="button-row">
                <button className="button button--secondary" onClick={() => void checkoutQuery.refetch()} type="button">
                  Reintentar
                </button>
                <button className="button button--primary" onClick={browseCatalog} type="button">
                  Volver al catálogo
                </button>
              </div>
            </div>
          ) : checkout ? (
            <section className="checkout-layout checkout-layout--payment" aria-label="Estado del checkout">
              <div className="checkout-main">
                <div className="checkout-main-header">
                  <div>
                    <p className="eyebrow">Pedido {checkout.checkoutId.slice(0, 8)}</p>
                    <h2>Tu compra está en marcha.</h2>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Actualizar el estado del pedido"
                    onClick={() => void refreshCheckoutAndAttempt()}
                    type="button"
                  >
                    ↻
                  </button>
                </div>
                {checkoutError ? <p className="inline-error" role="alert">{checkoutError}</p> : null}
                <PaymentPanel
                  attempt={latestAttempt}
                  attemptLookupState={attemptLookupState}
                  canStartAttempt={canStartAttempt}
                  checkout={checkout}
                  onRefreshAttempt={refreshCheckoutAndAttempt}
                />
              </div>
              <CheckoutSummary checkout={checkout} />
            </section>
          ) : (
            <div className="large-message" role="status" aria-live="polite">
              <span className="loading-mark" aria-hidden="true" />
              <div><strong>Cargando el resumen</strong><p>Validando la reserva con el API…</p></div>
            </div>
          )
        ) : selectedProduct ? (
          <CheckoutDetailsForm
            busy={checkoutCreating}
            error={checkoutError ?? recoveryMessage ?? undefined}
            onBack={() => {
              setSelectedProduct(null);
              setCheckoutError(null);
            }}
            onSubmit={submitCheckout}
            product={selectedProduct}
          />
        ) : (
          <>
            {recoveryMessage ? (
              <div className="recovery-banner" role="status">
                <span aria-hidden="true">↻</span>
                <p>{recoveryMessage}</p>
                <button className="text-button" onClick={() => setRecoveryMessage(null)} type="button">
                  Entendido
                </button>
              </div>
            ) : null}
            <ProductCatalog
              error={productsQuery.isError
                ? getErrorMessage(productsQuery.error, 'Revisa la conexión con el API.')
                : undefined}
              isLoading={productsQuery.isLoading}
              onRetry={() => void productsQuery.refetch()}
              onSelect={(product) => {
                setCheckoutError(null);
                setSelectedProduct(product);
              }}
              products={productsQuery.data ?? []}
            />
          </>
        )}

        <section className="trust-strip" aria-label="Características del checkout">
          <div><span aria-hidden="true">↗</span><strong>Totales del lado del servidor</strong></div>
          <div><span aria-hidden="true">⌁</span><strong>Reserva atómica de inventario</strong></div>
          <div><span aria-hidden="true">◉</span><strong>Reintentos sin duplicar pagos</strong></div>
        </section>
      </main>

      <footer className="page-footer">
        <span>Payment Flow Lab <span aria-hidden="true">·</span> Iteración I4</span>
        <span>Los pagos de esta experiencia son exclusivamente de sandbox.</span>
      </footer>
    </div>
  );
}

function CheckoutProgress({ activeStep }: { activeStep: number }) {
  const steps = ['Producto', 'Entrega', 'Pago'];
  return (
    <nav className="progress-nav" aria-label="Progreso de compra">
      <ol>
        {steps.map((step, index) => {
          const number = index + 1;
          const completed = number < activeStep;
          const current = number === activeStep;
          return (
            <li
              aria-current={current ? 'step' : undefined}
              className={completed ? 'progress-step progress-step--complete' : current ? 'progress-step progress-step--current' : 'progress-step'}
              key={step}
            >
              <span className="progress-number" aria-hidden="true">{completed ? '✓' : number}</span>
              <span>{step}</span>
            </li>
          );
        })}
      </ol>
      <div className="progress-line" aria-hidden="true"><span style={{ width: `${((activeStep - 1) / 2) * 100}%` }} /></div>
    </nav>
  );
}

function canPayAgain(checkout: Checkout, attempt?: { state: string; attemptNumber: number }): boolean {
  if (!['RESERVED', 'PAYMENT_FAILED'].includes(checkout.state)) return false;
  if (checkout.reservation.state !== 'HELD' || new Date(checkout.reservation.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  if (!attempt) return true;
  if (['CREATED', 'DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME', 'APPROVED', 'VOIDED'].includes(attempt.state)) {
    return false;
  }
  if (['DECLINED', 'ERROR'].includes(attempt.state)) return attempt.attemptNumber < 2;
  return ['FAILED_LOCAL', 'REJECTED_NO_TRANSACTION'].includes(attempt.state) && attempt.attemptNumber < 10;
}

function readCheckoutId(): string | null {
  const id = new URLSearchParams(window.location.search).get('checkout');
  return id && UUID_V4.test(id) ? id : null;
}

function hasInvalidCheckoutId(): boolean {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('checkout');
  return id !== null && !UUID_V4.test(id);
}

function readCheckoutCommandKey(): string | null {
  try {
    const value = window.sessionStorage.getItem(CHECKOUT_COMMAND_KEY);
    return value && /^[A-Za-z0-9._:-]{16,128}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function createOrReadCheckoutCommandKey(): string | null {
  const existing = readCheckoutCommandKey();
  if (existing) return existing;
  const value = crypto.randomUUID();
  try {
    window.sessionStorage.setItem(CHECKOUT_COMMAND_KEY, value);
    return value;
  } catch {
    return null;
  }
}

function clearCheckoutCommandKey(): void {
  try {
    window.sessionStorage.removeItem(CHECKOUT_COMMAND_KEY);
  } catch {
    // Storage can be unavailable; the checkout URL remains the recovery path after creation.
  }
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  const status = error.status;
  return typeof status === 'number' ? status : null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = error.data;
    if (typeof data === 'object' && data !== null && 'message' in data) {
      const message = data.message;
      if (typeof message === 'string') return message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
