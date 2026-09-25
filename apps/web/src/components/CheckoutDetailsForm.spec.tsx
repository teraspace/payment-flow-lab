import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckoutDetailsForm } from './CheckoutDetailsForm';
import { makeProduct } from '../test-fixtures';

describe('CheckoutDetailsForm', () => {
  it('collects trimmed delivery details and quantity', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    render(
      <CheckoutDetailsForm busy={false} onBack={jest.fn()} onSubmit={onSubmit} product={makeProduct()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Agregar una unidad' }));
    await user.type(screen.getByLabelText('Nombre completo'), '  Ada Lovelace  ');
    await user.type(screen.getByLabelText('Correo electrónico'), 'ada@example.test');
    await user.type(screen.getByLabelText('Persona que recibe'), ' Ada ');
    await user.type(screen.getByLabelText('Dirección completa'), ' Calle 1 #2-3 ');
    fireEvent.submit(screen.getByRole('button', { name: /Revisar y continuar/ }).closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith({
      productId: 'product-1',
      quantity: 2,
      customer: { fullName: 'Ada Lovelace', email: 'ada@example.test' },
      delivery: { recipient: 'Ada', address: 'Calle 1 #2-3' },
    });
  });

  it('caps quantity to available stock and disables actions while busy', async () => {
    const user = userEvent.setup();
    const onBack = jest.fn();
    render(
      <CheckoutDetailsForm busy onBack={onBack} onSubmit={jest.fn()} product={makeProduct({ availableQuantity: 1 })} />,
    );
    expect(screen.getByRole('button', { name: 'Agregar una unidad' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Reservando inventario/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Volver al catálogo/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Hasta 1 disponibles')).toBeInTheDocument();
  });

  it('shows a submission error and caps an unusually high stock count', () => {
    render(
      <CheckoutDetailsForm busy={false} error="Intenta más tarde" onBack={jest.fn()} onSubmit={jest.fn()} product={makeProduct({ availableQuantity: 200 })} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Intenta más tarde');
    expect(screen.getByText('Hasta 99 disponibles')).toBeInTheDocument();
  });
});
