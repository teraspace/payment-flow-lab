import { formatCop } from '../app/format';
import type { Product } from '../app/service-api';

interface ProductCatalogProps {
  products: Product[];
  isLoading: boolean;
  loadingLabel?: string;
  error?: string;
  onRetry: () => void;
  onSelect: (product: Product) => void;
}

export function ProductCatalog({
  products,
  isLoading,
  loadingLabel = 'Cargando productos',
  error,
  onRetry,
  onSelect,
}: ProductCatalogProps) {
  return (
    <section className="catalog-section" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Selección de productos</p>
          <h1 id="catalog-title">Compra algo que te guste.</h1>
        </div>
        <p className="section-note">Precios e inventario disponibles en tiempo real.</p>
      </div>

      {isLoading ? (
        <div aria-label={loadingLabel} className="catalog-loading" role="status" aria-live="polite">
          <div aria-hidden="true" className="product-grid">
            {Array.from({ length: 3 }, (_, index) => (
              <article className="product-card product-card--skeleton" key={index}>
                <div className={`product-art product-art--${index} product-art--skeleton`} />
                <div className="product-copy product-copy--skeleton">
                  <span className="skeleton-shape skeleton-meta" />
                  <span className="skeleton-shape skeleton-title" />
                  <span className="skeleton-shape skeleton-description" />
                  <span className="skeleton-shape skeleton-description skeleton-description--short" />
                  <div className="skeleton-footer">
                    <span className="skeleton-shape skeleton-price" />
                    <span className="skeleton-shape skeleton-action" />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="message-card message-card--error" role="alert">
          <div>
            <strong>No pudimos cargar el catálogo.</strong>
            <p>{error}</p>
          </div>
          <button className="button button--secondary" onClick={onRetry} type="button">
            Reintentar
          </button>
        </div>
      ) : products.length === 0 ? (
        <div className="empty-state">
          <p>Por ahora no hay productos disponibles.</p>
        </div>
      ) : (
        <div className="product-grid">
          {products.map((product, index) => (
            <article className="product-card" key={product.id}>
              <div className={`product-art product-art--${index % 3}`}>
                <img src={product.imageUrl} alt={product.name} height="164" loading="lazy" width="240" />
                <span className="product-stock">
                  {product.availableQuantity > 0
                    ? `${product.availableQuantity} disponibles`
                    : 'Agotado'}
                </span>
              </div>
              <div className="product-copy">
                <div className="product-meta">
                  <span>{product.sku}</span>
                  <span>{product.availableQuantity > 0 ? 'Listo para enviar' : 'Sin unidades'}</span>
                </div>
                <h2>{product.name}</h2>
                <p>{product.description}</p>
                <div className="product-footer">
                  <strong>{formatCop(product.unitPriceMinor, product.currency)}</strong>
                  <button
                    className="button button--primary"
                    disabled={product.availableQuantity < 1}
                    onClick={() => onSelect(product)}
                    type="button"
                  >
                    Elegir producto
                    <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
