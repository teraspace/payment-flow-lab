/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PAYMENT_GATEWAY_ENVIRONMENT?: 'test' | 'prod';
  readonly VITE_PAYMENT_GATEWAY_BASE_URL?: string;
  readonly VITE_PAYMENT_GATEWAY_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
