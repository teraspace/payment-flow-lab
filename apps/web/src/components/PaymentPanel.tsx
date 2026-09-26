import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatCop, formatDateTime } from '../app/format';
import {
  ApiRequestError,
  submitPaymentAttempt,
  type Checkout,
  type PaymentAttempt,
} from '../app/service-api';
import {
  getSandboxPaymentConfiguration,
  type AcceptanceDocuments,
} from '../app/sandbox-payment';

type AttemptLookupState = 'loading' | 'not-found' | 'error' | 'found';

interface PaymentPanelProps {
  checkout: Checkout;
  attempt?: PaymentAttempt;
  attemptLookupState: AttemptLookupState;
  canStartAttempt: boolean;
  paymentToken: string | null;
  paymentAcceptance: AcceptanceDocuments | null;
  onRequestCard: (trigger?: HTMLButtonElement) => void;
  onPaymentTokenUsed: () => void;
  onAttemptResult: (attempt: PaymentAttempt) => void;
  onRefreshAttempt: () => Promise<unknown>;
}

const PAYMENT_RECOVERY_DELAY_MS = 10_000;
const PAYMENT_RECOVERY_KEY_PREFIX = 'pfl.payment-recovery.v1:';

export function PaymentPanel({
  checkout,
  attempt,
  attemptLookupState,
  canStartAttempt,
  paymentToken,
  paymentAcceptance,
  onRequestCard,
  onPaymentTokenUsed,
  onAttemptResult,
  onRefreshAttempt,
}: PaymentPanelProps) {
  const paymentConfiguration = useMemo(() => getSandboxPaymentConfiguration(), []);
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPaymentError(null);

    if (!paymentConfiguration.ready || !paymentAcceptance) {
      setPaymentError('El pago sandbox no está listo para enviar.');
      return;
    }
    if (!paymentToken) {
      setPaymentError('Ingresa una tarjeta de prueba antes de confirmar el pago.');
      onRequestCard();
      return;
    }

    setSubmitting(true);
    let paymentRequestStarted = false;
    try {
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
        acceptanceToken: paymentAcceptance.acceptanceToken,
        personalDataAuthorizationToken: paymentAcceptance.personalDataAuthorizationToken,
        installments,
      });
      clearPaymentRecoveryStart(checkout.checkoutId);
      setRecoveryPendingRequested(false);
      setSubmittedAttempt(result);
      onAttemptResult(result);
      onPaymentTokenUsed();
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
              : 'No se pudo iniciar el pago de prueba.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="payment-panel" aria-labelledby="payment-title">
      <div className="payment-heading">
        <div>
          <p className="eyebrow">Paso 3 de 5 · Pago seguro</p>
          <h2 id="payment-title">Confirma el pago de prueba.</h2>
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
            <form className="payment-form" onSubmit={submit}>
              {paymentAcceptance ? (
                <div className="consent-confirmed" role="status">
                  <strong>Autorizaciones aceptadas</strong>
                  <span>
                    <a href={paymentAcceptance.acceptanceUrl} rel="noreferrer" target="_blank">Privacidad</a>
                    {' · '}
                    <a href={paymentAcceptance.personalDataAuthorizationUrl} rel="noreferrer" target="_blank">Tratamiento de datos</a>
                  </span>
                </div>
              ) : null}

              {!paymentToken ? (
                <div className="message-card message-card--info">
                  <div>
                    <strong>Tarjeta y autorización requeridas</strong>
                    <p>Después de una actualización, vuelve a ingresar la tarjeta ficticia y aceptar los documentos.</p>
                  </div>
                  <button className="button button--secondary" onClick={(event) => onRequestCard(event.currentTarget)} type="button">
                    Ingresar tarjeta
                  </button>
                </div>
              ) : (
                <p className="payment-token-ready" role="status">Tarjeta ficticia tokenizada para sandbox.</p>
              )}

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
                disabled={submitting || !paymentToken || !paymentAcceptance}
                type="submit"
              >
                {submitting ? 'Enviando pago a sandbox…' : `Pagar ${formatCop(checkout.totalAmountInMinorUnits, checkout.currency)}`}
                <span aria-hidden="true">→</span>
              </button>
              <p className="privacy-note">
                El intento se registra primero como PENDING en el API. El token se consume una sola vez y el estado se concilia con el proveedor.
              </p>
            </form>
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
      title: attempt.dispatching ? 'Enviando pago a sandbox' : 'Pago pendiente de confirmación',
      description: attempt.dispatching
        ? 'El API ya guardó la transacción como PENDING antes de llamar al proveedor.'
        : 'Conservamos tu reserva y consultamos el estado automáticamente.',
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
