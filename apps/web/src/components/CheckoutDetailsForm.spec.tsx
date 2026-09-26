jest.mock('../app/service-api', () => ({
  loadAcceptanceDocumentsFromApi: jest.fn(),
}));

jest.mock('../app/sandbox-payment', () => ({
  getSandboxPaymentConfiguration: jest.fn(),
  SANDBOX_TEST_CARDS: {
    approved: '4242424242424242',
    declined: '4111111111111111',
  },
  tokenizeSandboxCard: jest.fn(),
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  loadAcceptanceDocumentsFromApi,
} from '../app/service-api';
import {
  getSandboxPaymentConfiguration,
  tokenizeSandboxCard,
} from '../app/sandbox-payment';
import { CheckoutDetailsForm } from './CheckoutDetailsForm';
import { makeProduct } from '../test-fixtures';

const acceptance = {
  acceptanceToken: 'sandbox-acceptance-token',
  acceptanceUrl: 'https://provider.example.test/privacy.pdf',
  personalDataAuthorizationToken: 'sandbox-data-token',
  personalDataAuthorizationUrl: 'https://provider.example.test/data.pdf',
};

const mockAcceptance = jest.mocked(loadAcceptanceDocumentsFromApi);
const mockConfiguration = jest.mocked(getSandboxPaymentConfiguration);
const mockTokenize = jest.mocked(tokenizeSandboxCard);

function renderModal(props: Partial<React.ComponentProps<typeof CheckoutDetailsForm>> = {}) {
  return render(
    <CheckoutDetailsForm
      busy={false}
      onBack={jest.fn()}
      onSubmit={jest.fn()}
      product={makeProduct()}
      {...props}
    />,
  );
}

async function fillCheckoutAndCard(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Nombre completo'), 'Ada Lovelace');
  await user.type(screen.getByLabelText('Correo electrónico'), 'ada@example.test');
  await user.type(screen.getByLabelText('Persona que recibe'), 'Ada Lovelace');
  await user.type(screen.getByLabelText('Dirección completa'), 'Calle 1 #2-3, Bogotá');
  await user.type(screen.getByLabelText('Nombre en la tarjeta'), 'Ada Test');
  await user.type(screen.getByLabelText('Número de tarjeta de prueba'), '4242424242424242');
  await user.selectOptions(screen.getByLabelText('Mes'), '12');
  await user.type(screen.getByLabelText('Año'), '40');
  await user.type(screen.getByLabelText('CVC'), '123');
  await user.click(screen.getByLabelText(/Leí y acepto/));
  await user.click(screen.getByLabelText(/Autorizo el tratamiento/));
}

describe('CheckoutDetailsForm', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockConfiguration.mockReturnValue({ ready: true, configuration: { environment: 'test' } });
    mockAcceptance.mockResolvedValue(acceptance);
    mockTokenize.mockResolvedValue('tok_test_opaque');
  });

  it('keeps keyboard focus in the modal and restores the previous control on close', async () => {
    const user = userEvent.setup();
    const launchButton = document.createElement('button');
    launchButton.textContent = 'Open checkout';
    document.body.append(launchButton);
    launchButton.focus();
    const onBack = jest.fn();
    const { unmount } = renderModal({ onBack });

    expect(screen.getByRole('heading', { name: 'Pay with credit card' })).toHaveFocus();
    await screen.findByLabelText(/Leí y acepto/);
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Volver' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cerrar ventana de pago' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);

    unmount();
    expect(launchButton).toHaveFocus();
    launchButton.remove();
  });

  it('collects delivery and card data in the required modal and tokenizes only after consent', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const onDraftChange = jest.fn();
    let tokenizedCard: unknown;
    mockTokenize.mockImplementation(async (card) => {
      tokenizedCard = { ...card };
      return 'tok_test_opaque';
    });
    renderModal({ onSubmit, onDraftChange });

    expect(screen.getByRole('dialog', { name: 'Pay with credit card' })).toBeInTheDocument();
    expect(screen.getByLabelText('Número de tarjeta de prueba')).toBeInTheDocument();
    expect(screen.getByLabelText('Dirección completa')).toBeInTheDocument();
    await screen.findByLabelText(/Leí y acepto/);
    await fillCheckoutAndCard(user);
    await user.click(screen.getByRole('button', { name: 'Continuar al resumen' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      {
        productId: 'product-1',
        quantity: 1,
        customer: { fullName: 'Ada Lovelace', email: 'ada@example.test' },
        delivery: { recipient: 'Ada Lovelace', address: 'Calle 1 #2-3, Bogotá' },
      },
      'tok_test_opaque',
      acceptance,
    ));
    expect(tokenizedCard).toEqual({
      number: '4242424242424242',
      expMonth: '12',
      expYear: '40',
      cvc: '123',
      cardHolder: 'Ada Test',
    });
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      customer: { fullName: 'Ada Lovelace', email: 'ada@example.test' },
    }));
    expect(screen.getByLabelText('Número de tarjeta de prueba')).toHaveValue('');
  });

  it('refuses to tokenize without both consents and clears raw card fields after a tokenization error', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    mockTokenize.mockRejectedValue(new Error('Invalid sandbox test card'));
    renderModal({ onSubmit });
    await screen.findByLabelText(/Leí y acepto/);
    await fillCheckoutAndCard(user);

    // Clear one consent to exercise the handler guard even if a browser submits the form directly.
    await user.click(screen.getByLabelText(/Autorizo el tratamiento/));
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Debes aceptar ambos documentos');
    expect(mockTokenize).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText(/Autorizo el tratamiento/));
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid sandbox test card');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Número de tarjeta de prueba')).toHaveValue('');
  });
});
