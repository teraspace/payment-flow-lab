import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { ProductCatalog } from './ProductCatalog';
import { makeProduct } from '../test-fixtures';

describe('ProductCatalog', () => {
  it('shows loading feedback accessibly', async () => {
    const { container } = render(
      <ProductCatalog isLoading onRetry={jest.fn()} onSelect={jest.fn()} products={[]} />,
    );
    expect(screen.getByRole('status')).toHaveAccessibleName('Cargando productos');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows an error and retries on request', async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();
    render(
      <ProductCatalog error="API no disponible" isLoading={false} onRetry={onRetry} onSelect={jest.fn()} products={[]} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('API no disponible');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows an empty catalog', () => {
    render(<ProductCatalog isLoading={false} onRetry={jest.fn()} onSelect={jest.fn()} products={[]} />);
    expect(screen.getByText('Por ahora no hay productos disponibles.')).toBeInTheDocument();
  });

  it('renders products, disables exhausted stock, and selects available items', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    const available = makeProduct();
    const exhausted = makeProduct({
      id: 'product-2',
      sku: 'out-of-stock',
      name: 'Sin inventario',
      availableQuantity: 0,
    });
    render(
      <ProductCatalog isLoading={false} onRetry={jest.fn()} onSelect={onSelect} products={[available, exhausted]} />,
    );
    expect(screen.getByText('8 disponibles')).toBeInTheDocument();
    expect(screen.getByText('Agotado')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /Pay with credit card/ });
    expect(buttons[1]).toBeDisabled();
    await user.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith(available);
  });
});
