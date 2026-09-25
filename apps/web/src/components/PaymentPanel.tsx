import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatCop, formatDateTime } from '../app/format';
import {
  ApiRequestError,
  loadAcceptanceDocumentsFromApi,
  submitPaymentAttempt,
  type Checkout,
  type PaymentAttempt,
} from '../app/service-api';
import {
  getSandboxPaymentConfiguration,
  SANDBOX_TEST_CARDS,
  tokenizeSandboxCard,
  type AcceptanceDocuments,
  type SandboxCardData,
} from '../app/sandbox-payment';

type AttemptLookupState = 'loading' | 'not-found' | 'error' | 'found';

interface PaymentPanelProps {
  checkout: Checkout;
  attempt?: PaymentAttempt;
  attemptLookupState: AttemptLookupState;
  canStartAttempt: boolean;
  onRefreshAttempt: () => Promise<unknown>;
}

const PAYMENT_RECOVERY_DELAY_MS = 10_000;
const PAYMENT_RECOVERY_KEY_PREFIX = 'pfl.payment-recovery.v1:';

export function PaymentPanel({
  checkout,
  attempt,
  attemptLookupState,
  canStartAttempt,
  onRefreshAttempt,
}: PaymentPanelProps) {
  const paymentConfiguration = useMemo(() => getSandboxPaymentConfiguration(), []);
  const [acceptance, setAcceptance] = useState<AcceptanceDocuments | null>(null);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const [acceptanceLoading, setAcceptanceLoading] = useState(paymentConfiguration.ready);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPersonalData, setAcceptedPersonalData] = useState(false);
  const [installments, setInstallments] = useState(1);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedAttempt, setSubmittedAttempt] = useState<PaymentAttempt | null>(null);
  const [recoveryPendingRequested, setRecoveryPendingRequested] = useState(() =>
    readPaymentRecoveryStart(checkout.checkoutId) !== null,
  );

  const visibleAttempt = attempt ?? submittedAttempt;
  const recoveryStart = readPaymentRecoveryStart(checkout.checkoutId);
  const recoveryPending = Boolean(
    !visibleAttempt && recoveryPendingRequested && recoveryStart !== null,
  );
  const unresolved = visibleAttempt
    ? ['CREATED', 'DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(visibleAttempt.state)
    : false;

  useEffect(() => {
    if (!paymentConfiguration.ready) return;
    let active = true;
    loadAcceptanceDocumentsFromApi()
      .then((documents) => {
        if (active) setAcceptance(documents);
      })
      .catch(() => {
        if (active) setAcceptanceError('No pudimos obtener los contratos vigentes del sandbox.');
      })
      .finally(() => {
        if (active) setAcceptanceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [paymentConfiguration]);

  useEffect(() => {
    if (attempt) {
      clearPaymentRecoveryStart(checkout.checkoutId);
    }
  }, [attempt, checkout.checkoutId]);

  useEffect(() => {
    if (!recoveryPending || attemptLookupState !== 'not-found' || recoveryStart === null) {
      return;
    }

    const age = Date.now() - recoveryStart;
    if (age >= PAYMENT_RECOVERY_DELAY_MS) {
      const timer = window.setTimeout(() => {
        clearPaymentRecoveryStart(checkout.checkoutId);
        setRecoveryPendingRequested(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(() => {
      void onRefreshAttempt();
    }, Math.min(2_500, PAYMENT_RECOVERY_DELAY_MS - age));
    return () => window.clearTimeout(timer);
  }, [
    attempt,
    attemptLookupState,
    checkout.checkoutId,
    onRefreshAttempt,
    recoveryPending,
    recoveryStart,
  ]);

  useEffect(() => {
    if (!unresolved) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void onRefreshAttempt();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [onRefreshAttempt, unresolved]);

  function retryAcceptanceFetch() {
    if (!paymentConfiguration.ready) return;
    setAcceptance(null);
    setAcceptanceError(null);
    setAcceptanceLoading(true);
    loadAcceptanceDocumentsFromApi()
      .then(setAcceptance)
      .catch(() => setAcceptanceError('No pudimos obtener los contratos vigentes del sandbox.'))
      .finally(() => setAcceptanceLoading(false));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPaymentError(null);

    if (!paymentConfiguration.ready || !acceptance) {
      setPaymentError('El pago sandbox no está listo para enviar.');
      return;
    }
    if (!acceptedTerms || !acceptedPersonalData) {
      setPaymentError('Debes aceptar ambos documentos antes de continuar.');
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);
    const card: SandboxCardData = {
      number: String(formData.get('cardNumber') ?? ''),
      expMonth: String(formData.get('expMonth') ?? ''),
      expYear: String(formData.get('expYear') ?? ''),
      cvc: String(formData.get('cvc') ?? ''),
      cardHolder: String(formData.get('cardHolder') ?? ''),
    };
    form.reset();

    setSubmitting(true);
    let paymentRequestStarted = false;
    try {
      const paymentToken = await tokenizeSandboxCard(card);
      clearCardData(card);
      const commandKey = crypto.randomUUID();
      if (!writePaymentRecoveryStart(checkout.checkoutId, Date.now())) {
        throw new Error(
          'El navegador no permitió guardar la marca temporal de recuperación. No se envió el intento.',
        );
      }
      setRecoveryPendingRequested(true);
      paymentRequestStarted = true;

      const result = await submitPaymentAttempt(checkout.checkoutId, commandKey, {
        paymentToken,
        acceptanceToken: acceptance.acceptanceToken,
        personalDataAuthorizationToken: acceptance.personalDataAuthorizationToken,
        installments,
      });
      clearPaymentRecoveryStart(checkout.checkoutId);
      setRecoveryPendingRequested(false);
      setSubmittedAttempt(result);
      await onRefreshAttempt();
    } catch (error) {
      if (paymentRequestStarted) {
        setRecoveryPendingRequested(true);
        setPaymentError(
          'No pudimos confirmar la respuesta del intento. Estamos buscando su estado; no vuelvas a enviar el pago.',
        );
        await onRefreshAttempt().catch(() => undefined);
      } else {
        setPaymentError(
          error instanceof ApiRequestError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'No se pudo tokenizar la tarjeta de prueba.',
        );
      }
    } finally {
      clearCardData(card);
      setSubmitting(false);
    }
  }

  return (
    <section className="payment-panel" aria-labelledby="payment-title">
      <div className="payment-heading">
        <div>
          <p className="eyebrow">Paso 3 de 3 · Pago seguro</p>
          <h2 id="payment-title">Paga en ambiente de prueba.</h2>
        </div>
        <span className="sandbox-pill"><span aria-hidden="true">●</span> Sólo sandbox</span>
      </div>

      {visibleAttempt ? (
        <AttemptStatus attempt={visibleAttempt} />
      ) : attemptLookupState === 'loading' ? (
        <div className="inline-status" role="status" aria-live="polite">
          Consultando si ya existe un intento de pago…
        </div>
      ) : null}

      {attemptLookupState === 'error' && !visibleAttempt ? (
        <div className="message-card message-card--warning" role="alert">
          <div>
            <strong>No pudimos verificar el estado del pago.</strong>
            <p>Por seguridad, el formulario permanece bloqueado hasta confirmar si ya existe un intento.</p>
          </div>
          <button className="button button--secondary" onClick={() => void onRefreshAttempt()} type="button">
            Consultar de nuevo
          </button>
        </div>
      ) : null}

      {recoveryPending && !visibleAttempt ? (
        <div className="message-card message-card--warning" role="status" aria-live="polite">
          <div>
            <strong>Estamos recuperando el resultado.</strong>
            <p>No vuelvas a enviar el pago mientras confirmamos si el API recibió el intento.</p>
          </div>
          <button className="button button--secondary" onClick={() => void onRefreshAttempt()} type="button">
            Consultar estado
          </button>
        </div>
      ) : null}

      {visibleAttempt?.manualReviewRequired ? (
        <div className="message-card message-card--warning" role="status">
          <div>
            <strong>El intento requiere revisión.</strong>
            <p>La reserva continúa retenida. Este estado no autoriza otro cobro.</p>
          </div>
          <button className="button button--secondary" onClick={() => void onRefreshAttempt()} type="button">
            Consultar de nuevo
          </button>
        </div>
      ) : null}

      {visibleAttempt?.state === 'UNKNOWN_OUTCOME' ? (
        <div className="message-card message-card--warning" role="status">
          <div>
            <strong>El resultado todavía no está confirmado.</strong>
            <p>Conservamos tu reserva y bloqueamos un segundo intento hasta reconciliarlo.</p>
          </div>
          <button className="button button--secondary" onClick={() => void onRefreshAttempt()} type="button">
            Actualizar estado
          </button>
        </div>
      ) : null}

      {recoveryPending || unresolved || !canStartAttempt ? null : (
        <div className="sandbox-only">
          {!paymentConfiguration.ready ? (
            <div className="message-card message-card--info" role="status">
              <div>
                <strong>El pago está deshabilitado hasta configurar sandbox.</strong>
                <p>{paymentConfiguration.message}</p>
                <p>No se aceptan tarjetas reales ni se crean cobros reales en esta aplicación.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="test-card-note">
                <span className="test-card-icon" aria-hidden="true">✓</span>
                <div>
                  <strong>Usa exclusivamente una tarjeta de prueba</strong>
                  <p>
                    Aprobada: <code>{SANDBOX_TEST_CARDS.approved}</code> · Rechazada:{' '}
                    <code>{SANDBOX_TEST_CARDS.declined}</code>
                  </p>
                  <small>El formulario sólo tokeniza estos dos números y no tiene datos precargados.</small>
                </div>
              </div>

              {acceptanceLoading ? (
                <div className="inline-status" role="status">Cargando documentos de aceptación…</div>
              ) : acceptanceError ? (
                <div className="message-card message-card--error" role="alert">
                  <p>{acceptanceError}</p>
                  <button className="button button--secondary" onClick={retryAcceptanceFetch} type="button">
                    Volver a cargar
                  </button>
                </div>
              ) : acceptance ? (
                <form className="payment-form" onSubmit={submit}>
                  <fieldset className="consent-section">
                    <legend>Antes de pagar</legend>
                    <label className="consent-check">
                      <input
                        checked={acceptedTerms}
                        onChange={(event) => setAcceptedTerms(event.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        Leí y acepto la{' '}
                        <a href={acceptance.acceptanceUrl} rel="noreferrer" target="_blank">
                          política de privacidad
                        </a>.
                      </span>
                    </label>
                    <label className="consent-check">
                      <input
                        checked={acceptedPersonalData}
                        onChange={(event) => setAcceptedPersonalData(event.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        Autorizo el{' '}
                        <a
                          href={acceptance.personalDataAuthorizationUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          tratamiento de mis datos personales
                        </a>.
                      </span>
                    </label>
                  </fieldset>

                  <div className="card-form-grid">
                    <label className="field card-field--wide">
                      <span>Nombre de prueba en la tarjeta</span>
                      <input
                        autoComplete="off"
                        maxLength={120}
                        name="cardHolder"
                        required
                        type="text"
                      />
                    </label>
                    <label className="field card-field--wide">
                      <span>Número de tarjeta de prueba</span>
                      <input
                        autoComplete="off"
                        inputMode="numeric"
                        maxLength={19}
                        name="cardNumber"
                        pattern="[0-9 ]{16,19}"
                        placeholder="•••• •••• •••• ••••"
                        required
                        type="text"
                      />
                    </label>
                    <label className="field">
                      <span>Mes</span>
                      <select defaultValue="" name="expMonth" required>
                        <option disabled value="">Mes</option>
                        {Array.from({ length: 12 }, (_, index) => {
                          const month = String(index + 1).padStart(2, '0');
                          return <option key={month} value={month}>{month}</option>;
                        })}
                      </select>
                    </label>
                    <label className="field">
                      <span>Año</span>
                      <input
                        autoComplete="off"
                        inputMode="numeric"
                        maxLength={2}
                        minLength={2}
                        name="expYear"
                        pattern="[0-9]{2}"
                        placeholder="30"
                        required
                        type="text"
                      />
                    </label>
                    <label className="field">
                      <span>CVC de prueba</span>
                      <input
                        autoComplete="off"
                        inputMode="numeric"
                        maxLength={3}
                        minLength={3}
                        name="cvc"
                        pattern="[0-9]{3}"
                        required
                        type="password"
                      />
                    </label>
                  </div>

                  <label className="field installments-field">
                    <span>¿En cuántas cuotas quieres pagar?</span>
                    <select
                      onChange={(event) => setInstallments(Number(event.target.value))}
                      value={installments}
                    >
                      {[1, 2, 3, 6, 12].map((value) => (
                        <option key={value} value={value}>{value} {value === 1 ? 'cuota' : 'cuotas'}</option>
                      ))}
                    </select>
                  </label>

                  {paymentError ? <p className="inline-error" role="alert">{paymentError}</p> : null}

                  <button
                    className="button button--primary button--wide"
                    disabled={submitting || acceptanceLoading || !acceptedTerms || !acceptedPersonalData}
                    type="submit"
                  >
                    {submitting ? 'Tokenizando para sandbox…' : `Pagar ${formatCop(checkout.totalAmountInMinorUnits, checkout.currency)}`}
                    <span aria-hidden="true">→</span>
                  </button>
                  <p className="privacy-note">
                    La tarjeta se cifra en el navegador; el API retransmite sólo ese paquete cifrado al sandbox. El API nunca recibe el número ni el CVC legibles.
                  </p>
                </form>
              ) : null}
            </>
          )}
        </div>
      )}

      {canStartAttempt && visibleAttempt && !unresolved && !recoveryPending ? (
        <p className="retry-note">
          {visibleAttempt.state === 'DECLINED' || visibleAttempt.state === 'ERROR'
            ? 'Puedes hacer un único intento adicional mientras la reserva siga vigente.'
            : 'El último intento no llegó al procesador; puedes volver a probar con una tarjeta de sandbox.'}
        </p>
      ) : null}
    </section>
  );
}

function AttemptStatus({ attempt }: { attempt: PaymentAttempt }) {
  const messages: Record<PaymentAttempt['state'], { title: string; description: string; tone: string }> = {
    CREATED: {
      title: 'Preparando el intento',
      description: 'Estamos verificando el resultado antes de permitir otro intento.',
      tone: 'pending',
    },
    DISPATCHING: {
      title: 'Pago en proceso',
      description: 'La reserva se mantiene mientras confirmamos el resultado.',
      tone: 'pending',
    },
    FAILED_LOCAL: {
      title: 'El pago no salió del sistema',
      description: 'El procesador no recibió una solicitud de cobro.',
      tone: 'neutral',
    },
    REJECTED_NO_TRANSACTION: {
      title: 'El sandbox rechazó la solicitud',
      description: 'No se creó una transacción y puedes volver a probar mientras la reserva siga activa.',
      tone: 'neutral',
    },
    PENDING: {
      title: 'Pago pendiente de confirmación',
      description: 'Conservamos tu reserva y consultamos el estado automáticamente.',
      tone: 'pending',
    },
    UNKNOWN_OUTCOME: {
      title: 'Estamos conciliando el resultado',
      description: 'No repetiremos la solicitud ni liberaremos inventario mientras el resultado sea desconocido.',
      tone: 'warning',
    },
    APPROVED: {
      title: 'Pago aprobado en sandbox',
      description: 'La reserva quedó confirmada. Esta simulación no representa un cobro real.',
      tone: 'success',
    },
    DECLINED: {
      title: 'Pago de prueba rechazado',
      description: 'No se realizó un cobro real. Si la reserva sigue activa, queda un intento adicional.',
      tone: 'error',
    },
    ERROR: {
      title: 'El sandbox devolvió un error',
      description: 'No se confirmó el pago. Revisa el estado antes de iniciar otro intento.',
      tone: 'error',
    },
    VOIDED: {
      title: 'Pago anulado',
      description: 'El intento terminó y la reserva se liberó.',
      tone: 'neutral',
    },
  };
  const message = messages[attempt.state];

  return (
    <div className={`attempt-status attempt-status--${message.tone}`} role="status" aria-live="polite">
      <span className="attempt-status-mark" aria-hidden="true">
        {attempt.state === 'APPROVED' ? '✓' : attempt.state === 'DECLINED' || attempt.state === 'ERROR' ? '!' : '•'}
      </span>
      <div>
        <strong>{message.title}</strong>
        <p>{message.description}</p>
        <small>
          Intento {attempt.attemptNumber} · {formatCop(attempt.amountCop, attempt.currency)} · actualizado {formatDateTime(attempt.updatedAt)}
        </small>
      </div>
    </div>
  );
}

function clearCardData(card: SandboxCardData): void {
  card.number = '';
  card.expMonth = '';
  card.expYear = '';
  card.cvc = '';
  card.cardHolder = '';
}

function readPaymentRecoveryStart(checkoutId: string): number | null {
  try {
    const value = window.sessionStorage.getItem(`${PAYMENT_RECOVERY_KEY_PREFIX}${checkoutId}`);
    if (!value) return null;
    const timestamp = Number(value);
    return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
  } catch {
    return null;
  }
}

function writePaymentRecoveryStart(checkoutId: string, timestamp: number): boolean {
  try {
    window.sessionStorage.setItem(`${PAYMENT_RECOVERY_KEY_PREFIX}${checkoutId}`, String(timestamp));
    return true;
  } catch {
    return false;
  }
}

function clearPaymentRecoveryStart(checkoutId: string): void {
  try {
    window.sessionStorage.removeItem(`${PAYMENT_RECOVERY_KEY_PREFIX}${checkoutId}`);
  } catch {
    // Storage can be unavailable in private browsing; the UI remains session-only.
  }
}
