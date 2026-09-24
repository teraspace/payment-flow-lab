# Web application

React + TypeScript + Redux Toolkit web foundation. The current page shows whether the versioned API and its PostgreSQL dependency are ready. It contains no checkout form or card data.

Run `npm run dev:web` from the repository root. Configure `VITE_API_BASE_URL` to change the API base URL; local development defaults to `http://localhost:3000/api/v1`.

Later checkout steps will retrieve canonical payment state from the API after refresh. The browser must never persist card details or provider secrets.
