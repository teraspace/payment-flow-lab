import { useGetReadinessQuery } from './app/service-api';

function ApiStatus() {
  const { data, error, isFetching } = useGetReadinessQuery();
  const ready = data?.status === 'ok';

  return (
    <div
      className={`status-card ${ready ? 'status-card--ready' : 'status-card--waiting'}`}
      role="status"
      aria-live="polite"
    >
      <span className="status-indicator" aria-hidden="true" />
      <div>
        <p className="status-label">API and database</p>
        <p className="status-value">
          {ready ? 'Connected' : isFetching ? 'Checking connection' : 'Unavailable'}
        </p>
      </div>
      {!ready && error ? (
        <button className="text-button" onClick={() => window.location.reload()}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function App() {
  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Payment Flow Lab home">
          <span className="wordmark-mark" aria-hidden="true">
            P
          </span>
          <span>Payment Flow Lab</span>
        </a>
        <span className="environment-tag">Development</span>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Checkout engineering challenge</p>
        <h1 id="page-title">A dependable checkout starts with a solid foundation.</h1>
        <p className="hero-copy">
          The app and API are connected. Product discovery and checkout steps will
          be introduced in the next feature iteration.
        </p>
        <ApiStatus />
      </section>

      <section className="foundation-grid" aria-label="Application foundation">
        <article className="foundation-card">
          <span className="card-index">01</span>
          <h2>Responsive web app</h2>
          <p>React, TypeScript, and Redux Toolkit are ready for the checkout flow.</p>
        </article>
        <article className="foundation-card">
          <span className="card-index">02</span>
          <h2>Versioned API</h2>
          <p>NestJS exposes health checks and an OpenAPI contract.</p>
        </article>
        <article className="foundation-card">
          <span className="card-index">03</span>
          <h2>Persistent foundation</h2>
          <p>PostgreSQL stores the catalog baseline with inventory constraints.</p>
        </article>
      </section>

      <footer className="page-footer">
        <span>Foundation iteration</span>
        <span>Local development</span>
      </footer>
    </main>
  );
}
