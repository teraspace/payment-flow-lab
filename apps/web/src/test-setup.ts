import '@testing-library/jest-dom';
import { toHaveNoViolations } from 'jest-axe';
import { TextDecoder, TextEncoder } from 'node:util';

expect.extend(toHaveNoViolations);

if (!AbortSignal.timeout) {
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: () => new AbortController().signal,
  });
}

Object.defineProperty(globalThis, '__VITE_ENV__', {
  configurable: true,
  value: {
    DEV: true,
    VITE_API_BASE_URL: 'http://localhost:3000/api/v1',
    VITE_PAYMENT_GATEWAY_ENVIRONMENT: 'test',
  },
  writable: true,
});

globalThis.fetch = jest.fn().mockRejectedValue(new Error('No fetch mock configured')) as typeof fetch;
if (!globalThis.TextEncoder) {
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
}
if (!globalThis.TextDecoder) {
  Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: TextDecoder });
}
