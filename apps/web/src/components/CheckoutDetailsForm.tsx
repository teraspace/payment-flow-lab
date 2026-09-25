import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { loadAcceptanceDocumentsFromApi } from '../app/service-api';
import type { Product } from '../app/service-api';
import {
  getSandboxPaymentConfiguration,
  SANDBOX_TEST_CARDS,
  tokenizeSandboxCard,
  type AcceptanceDocuments,
  type SandboxCardData,
} from '../app/sandbox-payment';

export interface CheckoutDetails {
  productId: string;
  quantity: number;
  customer: { fullName: string; email: string };
  delivery: { recipient: string; address: string };
}

interface CheckoutDetailsFormProps {
  product: Product;
  busy: boolean;
  existingCheckout?: boolean;
  initialDetails?: CheckoutDetails;
  error?: string;
  onBack: () => void;
  onDraftChange?: (details: CheckoutDetails) => void;
  returnFocusTo?: HTMLElement | null;
  onSubmit: (
    details: CheckoutDetails,
    paymentToken: string,
    acceptance: AcceptanceDocuments,
  ) => Promise<void> | void;
}

export function CheckoutDetailsForm({
  product,
  busy,
  existingCheckout = false,
  initialDetails,
  error,
  onBack,
  onDraftChange,
  onSubmit,
  returnFocusTo,
}: CheckoutDetailsFormProps) {
  const maximumQuantity = Math.max(1, Math.min(product.availableQuantity, 99));
  const paymentConfiguration = getSandboxPaymentConfiguration();
  const [quantity, setQuantity] = useState(initialDetails?.quantity ?? 1);
  const [tokenizing, setTokenizing] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [acceptance, setAcceptance] = useState<AcceptanceDocuments | null>(null);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const [acceptanceLoading, setAcceptanceLoading] = useState(paymentConfiguration.ready);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPersonalData, setAcceptedPersonalData] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const previouslyFocused = returnFocusTo ?? document.activeElement;
    headingRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
        window.requestAnimationFrame(() => {
          if (previouslyFocused.isConnected && document.activeElement === document.body) {
            previouslyFocused.focus();
          }
        });
      }
    };
  }, [returnFocusTo]);

  useEffect(() => {
    if (!paymentConfiguration.ready) return;
    let active = true;
    loadAcceptanceDocumentsFromApi()
      .then((documents) => { if (active) setAcceptance(documents); })
      .catch(() => { if (active) setAcceptanceError('No pudimos obtener los contratos del sandbox.'); })
      .finally(() => { if (active) setAcceptanceLoading(false); });
    return () => { active = false; };
  }, [paymentConfiguration.ready]);
  useEffect(() => {
    function handleModalKeys(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy && !tokenizing) {
        onBack();
        return;
      }
      if (event.key !== 'Tab') return;

      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
      ) ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', handleModalKeys);
    return () => window.removeEventListener('keydown', handleModalKeys);
  }, [busy, onBack, tokenizing]);

  function readDetails(form: HTMLFormElement, nextQuantity = quantity): CheckoutDetails {
    const formData = new FormData(form);
    return {
      productId: product.id,
      quantity: nextQuantity,
      customer: {
        fullName: String(formData.get('fullName') ?? '').trim(),
        email: String(formData.get('email') ?? '').trim(),
      },
      delivery: {
        recipient: String(formData.get('recipient') ?? '').trim(),
        address: String(formData.get('address') ?? '').trim(),
      },
    };
  }

  function handleDraftChange(event: ChangeEvent<HTMLFormElement>) {
    if (!existingCheckout && onDraftChange) onDraftChange(readDetails(event.currentTarget));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCardError(null);
    if (!paymentConfiguration.ready) {
      setCardError(paymentConfiguration.message);
      return;
    }
    if (!acceptance || acceptanceLoading) {
      setCardError('Espera a que carguen los documentos de aceptación antes de continuar.');
      return;
    }
    if (!acceptedTerms || !acceptedPersonalData) {
      setCardError('Debes aceptar ambos documentos antes de tokenizar la tarjeta.');
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
    const details = readDetails(form);
    const cardFields = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '[name="cardNumber"], [name="expMonth"], [name="expYear"], [name="cvc"], [name="cardHolder"]',
    );

    setTokenizing(true);
    setCardError(null);
    void (async () => {
      try {
        const paymentToken = await tokenizeSandboxCard(card);
        clearCard(card);
        cardFields.forEach((field) => { field.value = ''; });
        await onSubmit(details, paymentToken, acceptance);
      } catch (tokenizeError: unknown) {
        setCardError(
          tokenizeError instanceof Error
            ? tokenizeError.message
            : 'No se pudo tokenizar la tarjeta de prueba.',
        );
      } finally {
        clearCard(card);
        cardFields.forEach((field) => { field.value = ''; });
        setTokenizing(false);
      }
    })();
  }

  function changeQuantity(nextQuantity: number, form: HTMLFormElement | null) {
    const bounded = Math.max(1, Math.min(maximumQuantity, nextQuantity));
    setQuantity(bounded);
    if (form && !existingCheckout && onDraftChange) {
      onDraftChange(readDetails(form, bounded));
    }
  }

  function retryAcceptanceFetch() {
    if (!paymentConfiguration.ready) return;
    setAcceptance(null);
    setAcceptanceError(null);
    setAcceptanceLoading(true);
    loadAcceptanceDocumentsFromApi()
      .then(setAcceptance)
      .catch(() => setAcceptanceError('No pudimos obtener los contratos del sandbox.'))
      .finally(() => setAcceptanceLoading(false));
  }

  const unavailable = !existingCheckout && product.availableQuantity < 1;

  return (
    <div className="modal-scrim">
      <section
        aria-labelledby="details-title"
        aria-modal="true"
        className="checkout-modal"
        ref={dialogRef}
        role="dialog"
      >
        <div className="checkout-modal__heading">
          <div>
            <p className="eyebrow">Paso 2 de 5 · Tarjeta y entrega</p>
            <h2 id="details-title" ref={headingRef} tabIndex={-1}>
              {existingCheckout ? 'Ingresa tu tarjeta de prueba' : 'Pay with credit card'}
            </h2>
            <p className="form-intro">
              {existingCheckout
                ? 'El checkout ya está guardado. La tarjeta no se conserva después de cerrar o actualizar la página.'
                : 'Completa los datos de entrega y una tarjeta ficticia de sandbox. Nunca guardamos el número ni el código de seguridad.'}
            </p>
          </div>
          <button
            aria-label="Cerrar ventana de pago"
            className="icon-button"
            disabled={busy || tokenizing}
            onClick={onBack}
            type="button"
          >
            ×
          </button>
        </div>

        <form className="details-form checkout-modal__form" onChange={handleDraftChange} onSubmit={submit}>
          {!existingCheckout ? (
            <div className="quantity-row">
              <div>
                <span className="field-label">{product.name}</span>
                <span className="muted-copy">{product.availableQuantity} unidades disponibles</span>
              </div>
              <div className="quantity-control" aria-label="Cantidad">
                <button
                  aria-label="Quitar una unidad"
                  disabled={quantity <= 1 || busy || tokenizing}
                  onClick={(event) => changeQuantity(quantity - 1, event.currentTarget.form)}
                  type="button"
                >−</button>
                <output aria-live="polite">{quantity}</output>
                <button
                  aria-label="Agregar una unidad"
                  disabled={quantity >= maximumQuantity || busy || tokenizing}
                  onClick={(event) => changeQuantity(quantity + 1, event.currentTarget.form)}
                  type="button"
                >+</button>
              </div>
            </div>
          ) : null}

          <div className="checkout-modal__columns">
            <fieldset className="form-section">
              <legend>Datos de contacto y entrega</legend>
              <label className="field">
                <span>Nombre completo</span>
                <input autoComplete="name" defaultValue={initialDetails?.customer.fullName ?? ''} maxLength={120} name="fullName" readOnly={existingCheckout} required type="text" />
              </label>
              <label className="field">
                <span>Correo electrónico</span>
                <input autoComplete="email" defaultValue={initialDetails?.customer.email ?? ''} maxLength={254} name="email" readOnly={existingCheckout} required type="email" />
              </label>
              <label className="field">
                <span>Persona que recibe</span>
                <input autoComplete="shipping name" defaultValue={initialDetails?.delivery.recipient ?? ''} maxLength={120} name="recipient" readOnly={existingCheckout} required type="text" />
              </label>
              <label className="field">
                <span>Dirección completa</span>
                <textarea autoComplete="shipping street-address" defaultValue={initialDetails?.delivery.address ?? ''} maxLength={240} minLength={5} name="address" readOnly={existingCheckout} required rows={2} />
              </label>
            </fieldset>

            <fieldset className="form-section card-entry-section">
              <legend>Tarjeta de prueba</legend>
              <div className="test-card-note">
                <span className="test-card-icon" aria-hidden="true">✓</span>
                <div>
                  <strong>Sandbox, sin cobros reales</strong>
                  <p>Prueba: <code>{SANDBOX_TEST_CARDS.approved}</code> · Rechazo: <code>{SANDBOX_TEST_CARDS.declined}</code></p>
                </div>
              </div>
              <label className="field">
                <span>Nombre en la tarjeta</span>
                <input autoComplete="cc-name" maxLength={120} name="cardHolder" required type="text" />
              </label>
              <label className="field">
                <span>Número de tarjeta de prueba</span>
                <input autoComplete="cc-number" inputMode="numeric" maxLength={19} name="cardNumber" pattern="[0-9 ]{16,19}" placeholder="•••• •••• •••• ••••" required type="text" />
              </label>
              <div className="card-form-grid">
                <label className="field">
                  <span>Mes</span>
                  <select autoComplete="cc-exp-month" defaultValue="" name="expMonth" required>
                    <option disabled value="">Mes</option>
                    {Array.from({ length: 12 }, (_, index) => {
                      const month = String(index + 1).padStart(2, '0');
                      return <option key={month} value={month}>{month}</option>;
                    })}
                  </select>
                </label>
                <label className="field">
                  <span>Año</span>
                  <input autoComplete="cc-exp-year" inputMode="numeric" maxLength={2} minLength={2} name="expYear" pattern="[0-9]{2}" placeholder="30" required type="text" />
                </label>
                <label className="field">
                  <span>CVC</span>
                  <input autoComplete="cc-csc" inputMode="numeric" maxLength={3} minLength={3} name="cvc" pattern="[0-9]{3}" required type="password" />
                </label>
              </div>
            </fieldset>
          </div>

          <fieldset className="consent-section checkout-modal__consent">
            <legend>Antes de tokenizar la tarjeta</legend>
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
              <>
                <label className="consent-check">
                  <input checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} type="checkbox" />
                  <span>Leí y acepto la <a href={acceptance.acceptanceUrl} rel="noreferrer" target="_blank">política de privacidad</a>.</span>
                </label>
                <label className="consent-check">
                  <input checked={acceptedPersonalData} onChange={(event) => setAcceptedPersonalData(event.target.checked)} type="checkbox" />
                  <span>Autorizo el <a href={acceptance.personalDataAuthorizationUrl} rel="noreferrer" target="_blank">tratamiento de mis datos personales</a>.</span>
                </label>
              </>
            ) : null}
          </fieldset>

          {error ? <p className="inline-error" role="alert">{error}</p> : null}
          {cardError ? <p className="inline-error" role="alert">{cardError}</p> : null}
          {unavailable ? <p className="inline-error" role="alert">Este producto no tiene unidades disponibles.</p> : null}

          <div className="checkout-modal__actions">
            <button className="button button--secondary" disabled={busy || tokenizing} onClick={onBack} type="button">
              Volver
            </button>
            <button className="button button--primary" disabled={busy || tokenizing || unavailable || !paymentConfiguration.ready || acceptanceLoading || !acceptance || !acceptedTerms || !acceptedPersonalData} type="submit">
              {tokenizing ? 'Tokenizando en sandbox…' : busy ? 'Reservando inventario…' : existingCheckout ? 'Volver al resumen' : 'Continuar al resumen'}
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <p className="privacy-note">
            La tarjeta se cifra en el navegador; sólo se conserva el token de prueba en memoria. El nombre, correo y dirección se guardan temporalmente en esta pestaña para recuperar el formulario si se actualiza.
          </p>
        </form>
      </section>
    </div>
  );
}

function clearCard(card: SandboxCardData): void {
  card.number = '';
  card.expMonth = '';
  card.expYear = '';
  card.cvc = '';
  card.cardHolder = '';
}
