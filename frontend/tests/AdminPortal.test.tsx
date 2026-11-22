import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminPortal } from '../src/admin/AdminPortal.tsx';
import { mockFetch } from './fetchMock.ts';

const patientId = `pat_${'p'.repeat(22)}`;
const resultId = `res_${'r'.repeat(22)}`;
const patient = {
  patientId,
  status: 'ACTIVE',
  dataClassification: 'SYNTHETIC',
  phoneMasked: '+52••••01',
  createdAt: '',
};
const result = (status: string) => ({
  resultId,
  patientId,
  resultType: 'PAPANICOLAOU',
  sampleDate: '2026-11-01',
  status,
  version: status === 'CREATED' ? 0 : 1,
  createdAt: '',
  updatedAt: '',
});

afterEach(() => vi.unstubAllGlobals());

async function findPatient() {
  const form = screen.getByRole('form', { name: 'Buscar expediente' });
  fireEvent.change(within(form).getByLabelText('Folio exacto'), { target: { value: 'SINT-0001' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Buscar' }));
  return screen.findByTestId('admin-result');
}

describe('AdminPortal', () => {
  it('carga un PDF con su SHA-256, lo sube con los encabezados firmados y lo envía a revisión', async () => {
    let status = 'CREATED';
    const calls = mockFetch({
      'GET /v1/admin/patients': () => ({ body: patient }),
      [`GET /v1/admin/patients/${patientId}/results`]: () => ({
        body: { results: [result(status)] },
      }),
      [`POST /v1/admin/results/${resultId}/upload-url`]: () => ({
        body: {
          url: '/local-documents/upload?sig=x',
          method: 'PUT',
          headers: { 'if-none-match': '*' },
          expiresIn: 300,
          version: 1,
        },
      }),
      'PUT /local-documents/upload': () => ({ status: 200 }),
      [`POST /v1/admin/results/${resultId}/submit`]: () => (
        (status = 'PENDING_REVIEW'),
        { body: result(status) }
      ),
    });
    render(<AdminPortal />);
    const card = await findPatient();
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], 'r.pdf', { type: 'application/pdf' });
    fireEvent.change(within(card).getByLabelText('Cargar PDF'), { target: { files: [pdf] } });
    expect(await screen.findByText(/verificado \(SHA-256\)/)).toBeInTheDocument();
    const sha = (await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array([37, 80, 68, 70]),
    )) as ArrayBuffer;
    const expected = btoa(String.fromCharCode(...new Uint8Array(sha)));
    const asked = calls.find((c) => c.key.endsWith('/upload-url'))!;
    expect(JSON.parse(String(asked.init!.body))).toEqual({
      contentType: 'application/pdf',
      sha256: expected,
      sizeBytes: 4,
    });
    const put = calls.find((c) => c.key.startsWith('PUT'))!;
    expect(put.init!.headers).toEqual({ 'if-none-match': '*' });
    expect(JSON.parse(String(calls.find((c) => c.key.endsWith('/submit'))!.init!.body))).toEqual({
      sha256: expected,
      sizeBytes: 4,
    });
  });

  it('un reintento tras cargar el mismo archivo completa submit aunque el PUT se rechace', async () => {
    const calls = mockFetch({
      'GET /v1/admin/patients': () => ({ body: patient }),
      [`GET /v1/admin/patients/${patientId}/results`]: () => ({
        body: { results: [result('CREATED')] },
      }),
      [`POST /v1/admin/results/${resultId}/upload-url`]: () => ({
        body: {
          url: '/local-documents/upload',
          method: 'PUT',
          headers: {},
          expiresIn: 300,
          version: 1,
        },
      }),
      'PUT /local-documents/upload': () => ({ status: 403 }),
      [`POST /v1/admin/results/${resultId}/submit`]: () => ({ body: result('PENDING_REVIEW') }),
    });
    render(<AdminPortal />);
    const card = await findPatient();
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], 'r.pdf', { type: 'application/pdf' });
    fireEvent.change(within(card).getByLabelText('Cargar PDF'), { target: { files: [pdf] } });
    expect(await screen.findByText(/verificado \(SHA-256\)/)).toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/submit'))).toBe(true);
  });

  it('si el PUT se rechaza y submit no encuentra el archivo, informa el rechazo', async () => {
    mockFetch({
      'GET /v1/admin/patients': () => ({ body: patient }),
      [`GET /v1/admin/patients/${patientId}/results`]: () => ({
        body: { results: [result('CREATED')] },
      }),
      [`POST /v1/admin/results/${resultId}/upload-url`]: () => ({
        body: {
          url: '/local-documents/upload',
          method: 'PUT',
          headers: {},
          expiresIn: 300,
          version: 1,
        },
      }),
      'PUT /local-documents/upload': () => ({ status: 403 }),
      [`POST /v1/admin/results/${resultId}/submit`]: () => ({
        status: 409,
        body: { message: 'x' },
      }),
    });
    render(<AdminPortal />);
    const card = await findPatient();
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], 'r.pdf', { type: 'application/pdf' });
    fireEvent.change(within(card).getByLabelText('Cargar PDF'), { target: { files: [pdf] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El almacenamiento rechazó el archivo',
    );
  });

  it('Aprobar exige las tres verificaciones; corrección envía la nota', async () => {
    const calls = mockFetch({
      'GET /v1/admin/patients': () => ({ body: patient }),
      [`GET /v1/admin/patients/${patientId}/results`]: () => ({
        body: { results: [result('PENDING_REVIEW')] },
      }),
      [`POST /v1/admin/results/${resultId}/review`]: () => ({
        body: result('CORRECTION_REQUESTED'),
      }),
    });
    render(<AdminPortal />);
    const card = await findPatient();
    const approve = within(card).getByRole('button', { name: 'Aprobar' });
    expect(approve).toBeDisabled();
    fireEvent.click(within(card).getByLabelText(/corresponde/));
    fireEvent.click(within(card).getByLabelText(/completo/));
    expect(approve).toBeDisabled();
    fireEvent.click(within(card).getByLabelText(/legible/));
    expect(approve).toBeEnabled();
    fireEvent.change(within(card).getByLabelText(/Nota/), { target: { value: 'Página borrosa' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Solicitar corrección' }));
    await vi.waitFor(() => expect(calls.some((c) => c.key.endsWith('/review'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.key.endsWith('/review'))!.init!.body));
    expect(body).toEqual({
      decision: 'REQUEST_CORRECTION',
      checks: { correspondence: true, integrity: true, legibility: true },
      note: 'Página borrosa',
    });
  });

  it('rechaza archivos que no son PDF sin pedir URL de carga', async () => {
    const calls = mockFetch({
      'GET /v1/admin/patients': () => ({ body: patient }),
      [`GET /v1/admin/patients/${patientId}/results`]: () => ({
        body: { results: [result('CREATED')] },
      }),
    });
    render(<AdminPortal />);
    const card = await findPatient();
    const txt = new File(['hola'], 'a.txt', { type: 'text/plain' });
    fireEvent.change(within(card).getByLabelText('Cargar PDF'), { target: { files: [txt] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Solo se aceptan archivos PDF');
    expect(calls.some((c) => c.key.endsWith('/upload-url'))).toBe(false);
  });
});
