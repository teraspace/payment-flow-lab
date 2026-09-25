import { formatCop, formatDateTime } from './format';

describe('formatters', () => {
  it('formats COP without decimal digits', () => {
    expect(formatCop(125_000)).toMatch(/125[\s\u00a0.]?000/);
    expect(formatCop(125_000)).toContain('$');
  });

  it('supports an explicit currency', () => {
    expect(formatCop(2500, 'USD')).toContain('US$');
  });

  it('formats a valid date and reports invalid input', () => {
    expect(formatDateTime('2026-09-24T12:00:00.000Z')).not.toBe('Fecha no disponible');
    expect(formatDateTime('not-a-date')).toBe('Fecha no disponible');
  });
});
