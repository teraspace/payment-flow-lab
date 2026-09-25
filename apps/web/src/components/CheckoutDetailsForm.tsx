import { useState, type FormEvent } from 'react';
import { formatCop } from '../app/format';
import type { Product } from '../app/service-api';

interface CheckoutDetails {
  productId: string;
  quantity: number;
  customer: { fullName: string; email: string };
  delivery: { recipient: string; address: string };
}

interface CheckoutDetailsFormProps {
  product: Product;
  busy: boolean;
  error?: string;
  onBack: () => void;
  onSubmit: (details: CheckoutDetails) => void;
}

export function CheckoutDetailsForm({
  product,
  busy,
  error,
  onBack,
  onSubmit,
}: CheckoutDetailsFormProps) {
  const maximumQuantity = Math.min(product.availableQuantity, 99);
  const [quantity, setQuantity] = useState(1);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    onSubmit({
      productId: product.id,
      quantity,
      customer: {
        fullName: String(formData.get('fullName') ?? '').trim(),
        email: String(formData.get('email') ?? '').trim(),
      },
      delivery: {
        recipient: String(formData.get('recipient') ?? '').trim(),
        address: String(formData.get('address') ?? '').trim(),
      },
    });
  }

  return (
    <section className="checkout-layout" aria-labelledby="details-title">
      <div className="checkout-main">
        <button className="back-button" onClick={onBack} type="button">
          <span aria-hidden="true">←</span> Volver al catálogo
        </button>
        <p className="eyebrow">Paso 2 de 3 · Datos de envío</p>
        <h1 id="details-title">¿A dónde lo enviamos?</h1>
        <p className="form-intro">
          Usaremos estos datos sólo para este pedido. El API conserva la información personal
          durante 30 días desde la creación del checkout.
        </p>

        <form className="details-form" onSubmit={submit}>
          <fieldset className="form-section">
            <legend>Datos de contacto</legend>
            <label className="field">
              <span>Nombre completo</span>
              <input
                autoComplete="name"
                maxLength={120}
                name="fullName"
                required
                type="text"
              />
            </label>
            <label className="field">
              <span>Correo electrónico</span>
              <input
                autoComplete="email"
                maxLength={254}
                name="email"
                required
                type="email"
              />
            </label>
          </fieldset>

          <fieldset className="form-section">
            <legend>Entrega</legend>
            <label className="field">
              <span>Persona que recibe</span>
              <input
                autoComplete="shipping name"
                maxLength={120}
                name="recipient"
                required
                type="text"
              />
            </label>
            <label className="field">
              <span>Dirección completa</span>
              <textarea
                autoComplete="shipping street-address"
                maxLength={240}
                minLength={5}
                name="address"
                required
                rows={3}
              />
            </label>
          </fieldset>

          <div className="quantity-row">
            <div>
              <span className="field-label">Unidades</span>
              <span className="muted-copy">Hasta {maximumQuantity} disponibles</span>
            </div>
            <div className="quantity-control" aria-label="Cantidad">
              <button
                aria-label="Quitar una unidad"
                disabled={quantity <= 1}
                onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                type="button"
              >
                −
              </button>
              <output aria-live="polite">{quantity}</output>
              <button
                aria-label="Agregar una unidad"
                disabled={quantity >= maximumQuantity}
                onClick={() => setQuantity((value) => Math.min(maximumQuantity, value + 1))}
                type="button"
              >
                +
              </button>
            </div>
          </div>

          {error ? <p className="inline-error" role="alert">{error}</p> : null}

          <button className="button button--primary button--wide" disabled={busy} type="submit">
            {busy ? 'Reservando inventario…' : 'Revisar y continuar'}
            <span aria-hidden="true">→</span>
          </button>
          <p className="privacy-note">
            El precio final, cargos y disponibilidad se calculan en el servidor al crear la reserva.
          </p>
        </form>
      </div>

      <aside className="checkout-aside" aria-label="Producto seleccionado">
        <div className="aside-label">Tu selección</div>
        <div className="selected-product-art">
          <img src={product.imageUrl} alt="" />
        </div>
        <p className="selected-sku">{product.sku}</p>
        <h2>{product.name}</h2>
        <p className="selected-description">{product.description}</p>
        <div className="aside-total-line">
          <span>Subtotal estimado</span>
          <strong>{formatCop(product.unitPriceMinor * quantity, product.currency)}</strong>
        </div>
        <p className="aside-footnote">El resumen definitivo aparecerá después de reservar.</p>
      </aside>
    </section>
  );
}
