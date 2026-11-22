import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatientPortal } from '../src/patient/PatientPortal.tsx';
import { mockFetch } from './fetchMock.ts';

const challenge = { challengeId: 'c'.repeat(22), expiresIn: 300, resendAfter: 60 };
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function identify() {
  fill('Nombre completo', 'Ana Prueba Sintética');
  fill('Fecha de nacimiento', '1985-03-14');
  fill('Folio', 'SINT-0001');
  fireEvent.click(screen.getByRole('button', { name: 'Solicitar código' }));
  await screen.findByLabelText('Código de 6 dígitos');
}

afterEach(() => vi.unstubAllGlobals());

describe('PatientPortal', () => {
  it('flujo completo: código, resultados aprobados y URL de descarga con el token en memoria', async () => {
    const calls = mockFetch({
      'POST /v1/access/request': () => ({ status: 202, body: { ...challenge, demoPin: '123456' } }),
      'POST /v1/access/verify': () => ({ body: { token: 't'.repeat(43), expiresIn: 900 } }),
      'GET /v1/results': () => ({
        body: {
          results: [
            {
              resultId: `res_${'a'.repeat(22)}`,
              resultType: 'PAPANICOLAOU',
              sampleDate: '2026-10-01',
              availableAt: '',
            },
          ],
        },
      }),
      [`POST /v1/results/res_${'a'.repeat(22)}/download-url`]: () => ({
        body: { url: 'http://127.0.0.1:5173/local-documents?x', expiresIn: 60 },
      }),
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<PatientPortal />);
    await identify();
    expect(screen.getByTestId('demo-pin')).toHaveTextContent('123456');
    expect(screen.getByRole('button', { name: /Reenviar en/ })).toBeDisabled();
    fill('Código de 6 dígitos', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver PDF' }));
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'http://127.0.0.1:5173/local-documents?x',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    const download = calls.find((c) => c.key.endsWith('/download-url'))!;
    expect((download.init!.headers as Record<string, string>).authorization).toBe(
      `Bearer ${'t'.repeat(43)}`,
    );
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      fullName: 'Ana Prueba Sintética',
      birthDate: '1985-03-14',
      folio: 'SINT-0001',
    });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('sin demoPin no muestra código, y un PIN incorrecto muestra el error genérico', async () => {
    mockFetch({
      'POST /v1/access/request': () => ({ status: 202, body: challenge }),
      'POST /v1/access/verify': () => ({
        status: 401,
        body: { message: 'Código incorrecto o vencido' },
      }),
    });
    render(<PatientPortal />);
    await identify();
    expect(screen.queryByTestId('demo-pin')).toBeNull();
    fill('Código de 6 dígitos', '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Código incorrecto o vencido');
  });

  it('sesión vencida (401) regresa a la identificación', async () => {
    mockFetch({
      'POST /v1/access/request': () => ({ status: 202, body: challenge }),
      'POST /v1/access/verify': () => ({ body: { token: 't'.repeat(43), expiresIn: 900 } }),
      'GET /v1/results': () => ({
        body: {
          results: [
            {
              resultId: `res_${'a'.repeat(22)}`,
              resultType: 'PAPANICOLAOU',
              sampleDate: '2026-10-01',
              availableAt: '',
            },
          ],
        },
      }),
      [`POST /v1/results/res_${'a'.repeat(22)}/download-url`]: () => ({
        status: 401,
        body: { message: 'Unauthorized' },
      }),
    });
    render(<PatientPortal />);
    await identify();
    fill('Código de 6 dígitos', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tu sesión terminó');
    expect(screen.getByRole('button', { name: 'Solicitar código' })).toBeInTheDocument();
  });
});
