import { skipToken } from '@reduxjs/toolkit/query';
import { useCallback, useEffect, useState } from 'react';
import type { AcceptanceDocuments } from './app/sandbox-payment';
import {
  useCreateCheckoutMutation,
  useGetCheckoutQuery,
  useGetLatestPaymentAttemptQuery,
  useGetProductsQuery,
  useGetReadinessQuery,
  useInitializeGuestSessionMutation,
  useRecoverCheckoutMutation,
  type Checkout,
  type PaymentAttempt,
  type Product,
} from './app/service-api';
import { CheckoutDetailsForm, type CheckoutDetails } from './components/CheckoutDetailsForm';
import { CheckoutSummary } from './components/CheckoutSummary';
import { PaymentPanel } from './components/PaymentPanel';
import { ProductCatalog } from './components/ProductCatalog';

const CHECKOUT_COMMAND_KEY = 'pfl.checkout-command.v1';
const CHECKOUT_DRAFT_KEY = 'pfl.checkout-draft.v1';
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
  const [checkoutDraft, setCheckoutDraft] = useState<CheckoutDetails | null>(() => readCheckoutDraft());
  const [modalOpen, setModalOpen] = useState(() => readCheckoutDraft() !== null);
  const [paymentToken, setPaymentToken] = useState<string | null>(null);
  const [paymentAcceptance, setPaymentAcceptance] = useState<AcceptanceDocuments | null>(null);
  const [localPaymentAttempt, setLocalPaymentAttempt] = useState<PaymentAttempt | null>(null);
  const [returnedFromResult, setReturnedFromResult] = useState(false);
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
    skip: !sessionReady || !recoveryChecked,
  });
  const refetchProducts = productsQuery.refetch;

  const catalogProducts = productsQuery.data ?? [];
  const modalProduct = selectedProduct ?? catalogProducts.find((product) =>
    product.id === (checkoutId ? checkoutQuery.data?.item.productId : checkoutDraft?.productId),
  ) ?? null;
  const apiAttempt = paymentAttemptQuery.data;
  const latestAttempt = localPaymentAttempt &&
    (!apiAttempt || new Date(localPaymentAttempt.updatedAt) > new Date(apiAttempt.updatedAt))
    ? localPaymentAttempt
    : apiAttempt;
  const checkout = checkoutQuery.data;
  const attemptLookupState = paymentAttemptQuery.isSuccess
    ? 'found'
    : paymentAttemptQuery.isError && getErrorStatus(paymentAttemptQuery.error) === 404
      ? 'not-found'
      : paymentAttemptQuery.isError
        ? 'error'
        : 'loading';
  const unresolvedAttempt = Boolean(
    latestAttempt && ['CREATED', 'DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(latestAttempt.state),
  );
  const terminalResult = Boolean(
    checkout && !unresolvedAttempt && (
      ['PAID', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED', 'FULFILLMENT_EXCEPTION'].includes(checkout.state) ||
      ['APPROVED', 'DECLINED', 'ERROR', 'VOIDED'].includes(latestAttempt?.state ?? '')
    ) && !(paymentToken && paymentAcceptance && canPayAgain(checkout, latestAttempt)),
  );
  const modalVisible = modalOpen && modalProduct !== null;

  useEffect(() => {
    void initializeGuestSession().unwrap().catch(() => undefined);
  }, [initializeGuestSession]);

  const openCheckout = useCallback((id: string) => {
    setCheckoutId(id);
    setSelectedProduct(null);
    setModalOpen(false);
    setCheckoutDraft(null);
    setRecoveryMessage(null);
    setCheckoutError(null);
    setRecoveryChecked(true);
    clearCheckoutDraft();
    const url = new URL(window.location.href);
    url.searchParams.set('checkout', id);
    window.history.replaceState(null, '', url);
  }, []);

  const browseCatalog = useCallback(() => {
    setCheckoutId(null);
    setSelectedProduct(null);
    setModalOpen(false);
    setCheckoutDraft(null);
    setPaymentToken(null);
    setPaymentAcceptance(null);
    setLocalPaymentAttempt(null);
    setRecoveryMessage(null);
    setCheckoutError(null);
    setInvalidCheckoutLink(false);
    clearCheckoutDraft();
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    window.history.replaceState(null, '', url);
  }, []);

  const returnToCatalog = useCallback(() => {
    setReturnedFromResult(true);
    void refetchProducts();
    browseCatalog();
  }, [browseCatalog, refetchProducts]);

  const updateCheckoutDraft = useCallback((draft: CheckoutDetails) => {
    setCheckoutDraft(draft);
    writeCheckoutDraft(draft);
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

  useEffect(() => {
    if (!checkoutId || !terminalResult || modalOpen) return;
    const timer = window.setTimeout(returnToCatalog, 8_000);
    return () => window.clearTimeout(timer);
  }, [checkoutId, modalOpen, returnToCatalog, terminalResult]);

  async function submitCheckout(
    details: CheckoutDetails,
    nextPaymentToken: string,
    acceptance: AcceptanceDocuments,
  ) {
    setCheckoutError(null);
    if (checkoutId) {
      setPaymentToken(nextPaymentToken);
      setPaymentAcceptance(acceptance);
      setModalOpen(false);
      return;
    }
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
      setPaymentToken(nextPaymentToken);
      setPaymentAcceptance(acceptance);
      setLocalPaymentAttempt(null);
    } catch (error) {
      resetCheckoutCreation();
      try {
        const recovered = await recoverCheckout(commandKey).unwrap();
        resetCheckoutRecovery();
        clearCheckoutCommandKey();
        openCheckout(recovered.checkoutId);
        setPaymentToken(nextPaymentToken);
        setPaymentAcceptance(acceptance);
        setLocalPaymentAttempt(null);
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
  const activeStep = modalOpen
    ? 2
    : checkoutId ? terminalResult ? 4 : 3
      : returnedFromResult ? 5 : 1;
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

      <main aria-hidden={modalVisible || undefined} className="page-shell" id="main-content">
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
              <p>Consultamos la reserva en el API. Los datos de tarjeta nunca se guardan en el navegador.</p>
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
          ) : checkout && terminalResult ? (
            <section className="final-status" aria-labelledby="final-status-title">
              <FinalStatus
                attempt={latestAttempt}
                canRetry={canPayAgain(checkout, latestAttempt)}
                checkout={checkout}
                onReturn={returnToCatalog}
                onRetry={() => {
                  setCheckoutDraft(detailsFromCheckout(checkout));
                  setModalOpen(true);
                }}
              />
            </section>
          ) : checkout ? (
            <section className="summary-screen" aria-labelledby="summary-screen-title">
              <div className="summary-screen__heading">
                <p className="eyebrow">Paso 3 de 5 · Resumen</p>
                <h2 id="summary-screen-title">Confirma tu pedido.</h2>
                <p>Los importes y la disponibilidad vienen del API. La tarjeta permanece tokenizada sólo en esta pestaña.</p>
              </div>
              {checkoutError ? <p className="inline-error" role="alert">{checkoutError}</p> : null}
              <CheckoutSummary checkout={checkout}>
                <PaymentPanel
                  attempt={latestAttempt}
                  attemptLookupState={attemptLookupState}
                  canStartAttempt={canStartAttempt}
                  checkout={checkout}
                  paymentToken={paymentToken}
                  paymentAcceptance={paymentAcceptance}
                  onPaymentTokenUsed={() => {
                    setPaymentToken(null);
                    setPaymentAcceptance(null);
                  }}
                  onRefreshAttempt={refreshCheckoutAndAttempt}
                  onRequestCard={() => {
                    setCheckoutDraft(detailsFromCheckout(checkout));
                    setModalOpen(true);
                  }}
                  onAttemptResult={setLocalPaymentAttempt}
                />
              </CheckoutSummary>
              <button
                aria-label="Actualizar el estado del pedido"
                className="text-button summary-screen__refresh"
                onClick={() => void refreshCheckoutAndAttempt()}
                type="button"
              >
                Actualizar estado del pedido
              </button>
            </section>
          ) : (
            <div className="large-message" role="status" aria-live="polite">
              <span className="loading-mark" aria-hidden="true" />
              <div><strong>Cargando el resumen</strong><p>Validando la reserva con el API…</p></div>
            </div>
          )
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
              setReturnedFromResult(false);
              setSelectedProduct(product);
              const draft: CheckoutDetails = {
                productId: product.id,
                quantity: 1,
                customer: { fullName: '', email: '' },
                delivery: { recipient: '', address: '' },
              };
              setCheckoutDraft(draft);
              writeCheckoutDraft(draft);
              setModalOpen(true);
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

      {modalVisible && modalProduct ? (
        <CheckoutDetailsForm
          busy={checkoutCreating}
          error={checkoutError ?? undefined}
          existingCheckout={Boolean(checkoutId && checkout)}
          initialDetails={checkout ? detailsFromCheckout(checkout) : checkoutDraft ?? undefined}
          onBack={() => {
            setModalOpen(false);
            setCheckoutError(null);
            if (!checkoutId) {
              setSelectedProduct(null);
              setCheckoutDraft(null);
              clearCheckoutDraft();
            }
          }}
          onDraftChange={checkoutId ? undefined : updateCheckoutDraft}
          onSubmit={submitCheckout}
          product={modalProduct}
        />
      ) : null}

      <footer className="page-footer">
        <span>Payment Flow Lab</span>
        <span>Los pagos de esta experiencia son exclusivamente de sandbox.</span>
      </footer>
    </div>
  );
}

function CheckoutProgress({ activeStep }: { activeStep: number }) {
  const steps = ['Producto', 'Tarjeta y entrega', 'Resumen', 'Resultado', 'Producto'];
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
              key={`${number}-${step}`}
            >
              <span className="progress-number" aria-hidden="true">{completed ? '✓' : number}</span>
              <span>{step}</span>
            </li>
          );
        })}
      </ol>
      <div className="progress-line" aria-hidden="true"><span style={{ width: `${((activeStep - 1) / 4) * 100}%` }} /></div>
    </nav>
  );
}

function FinalStatus({
  attempt,
  canRetry,
  checkout,
  onReturn,
  onRetry,
}: {
  attempt?: PaymentAttempt;
  canRetry: boolean;
  checkout: Checkout;
  onReturn: () => void;
  onRetry: () => void;
}) {
  const approved = attempt?.state === 'APPROVED' || checkout.state === 'PAID';
  const title = approved
    ? 'Pago aprobado en sandbox'
    : checkout.state === 'FULFILLMENT_EXCEPTION'
      ? 'Tu pedido requiere revisión'
      : attempt?.state === 'VOIDED' || checkout.state === 'CANCELLED'
        ? 'El pago fue anulado'
        : attempt?.state === 'DECLINED' || attempt?.state === 'ERROR' || checkout.state === 'PAYMENT_FAILED'
          ? 'El pago no fue aprobado'
          : 'La reserva terminó';
  const description = approved
    ? 'El inventario se confirmó y el producto quedó asignado para entrega. No se hizo un cobro real.'
    : checkout.state === 'FULFILLMENT_EXCEPTION'
      ? 'El resultado del proveedor requiere conciliación manual antes de confirmar la entrega.'
      : 'El resultado quedó registrado y el catálogo mostrará las unidades disponibles actualizadas.';

  return (
    <div className="final-status-card" role="status" aria-live="polite">
      <span className={`final-status-mark${approved ? ' final-status-mark--success' : ''}`} aria-hidden="true">
        {approved ? '✓' : '!'}
      </span>
      <p className="eyebrow">Paso 4 de 5 · Resultado final</p>
      <h2 id="final-status-title">{title}</h2>
      <p>{description}</p>
      <p className="final-status-countdown">Volveremos al catálogo en unos segundos.</p>
      {canRetry ? (
        <button className="button button--secondary" onClick={onRetry} type="button">
          Reintentar con una nueva tarjeta de prueba
        </button>
      ) : null}
      <button className="button button--primary" onClick={onReturn} type="button">
        Ir al catálogo con inventario actualizado <span aria-hidden="true">→</span>
      </button>
    </div>
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

function readCheckoutDraft(): CheckoutDetails | null {
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_DRAFT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CheckoutDetails>;
    if (
      typeof value.productId !== 'string' || !UUID_V4.test(value.productId) ||
      !Number.isInteger(value.quantity) || (value.quantity ?? 0) < 1 || (value.quantity ?? 0) > 99 ||
      typeof value.customer?.fullName !== 'string' || typeof value.customer.email !== 'string' ||
      typeof value.delivery?.recipient !== 'string' || typeof value.delivery.address !== 'string'
    ) return null;
    return value as CheckoutDetails;
  } catch {
    return null;
  }
}

function writeCheckoutDraft(draft: CheckoutDetails): void {
  try {
    window.sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // The API checkout URL and idempotency record remain the recovery source after creation.
  }
}

function clearCheckoutDraft(): void {
  try {
    window.sessionStorage.removeItem(CHECKOUT_DRAFT_KEY);
  } catch {
    // Storage may be unavailable in private browsing.
  }
}

function detailsFromCheckout(checkout: Checkout): CheckoutDetails {
  return {
    productId: checkout.item.productId,
    quantity: checkout.item.quantity,
    customer: {
      fullName: checkout.customer.fullName ?? '',
      email: checkout.customer.email ?? '',
    },
    delivery: {
      recipient: checkout.delivery.recipient ?? '',
      address: checkout.delivery.address ?? '',
    },
  };
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
