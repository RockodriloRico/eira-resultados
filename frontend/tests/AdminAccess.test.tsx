import { buildFrontendConfig } from '@eira/shared';
import type { CognitoAdminConfig } from '@eira/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAccess } from '../src/admin/AdminAccess.tsx';
import { adminSignOut, adminUserManager } from '../src/admin/auth.ts';
import { App } from '../src/App.tsx';
import { setRuntimeConfig } from '../src/config/runtime.ts';
import example from '../../infrastructure/env/stack-outputs.example.json';

const config = buildFrontendConfig('demo', example.Outputs);
const admin = config.admin as CognitoAdminConfig;
const API = config.apiBaseUrl;
const b64 = (v: unknown) =>
  btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.firma`;
const now = () => Math.floor(Date.now() / 1000);
const idToken = () =>
  jwt({ sub: 'adm-1', iss: admin.authority, aud: admin.clientId, iat: now(), exp: now() + 900 });

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[];
let popupUrl: string | undefined;

function stubNetwork(apiStatus = () => 200) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === `${admin.domain}/oauth2/token`)
        return Response.json({
          access_token: 'token-de-acceso',
          id_token: idToken(),
          refresh_token: 'token-de-renovacion',
          token_type: 'Bearer',
          expires_in: 900,
        });
      if (url === `${admin.domain}/oauth2/revoke`) return new Response(null, { status: 200 });
      if (url.startsWith(`${API}/v1/admin/patients`))
        return Response.json({ message: 'Sesión vencida' }, { status: apiStatus() });
      return new Response(null, { status: 404 });
    }),
  );
  popupUrl = undefined;
  vi.spyOn(window, 'open').mockImplementation(
    () =>
      ({
        location: { replace: (url: string) => (popupUrl = url) },
        closed: false,
        close: vi.fn(),
        focus: vi.fn(),
      }) as unknown as Window,
  );
}

/** Simula la ventana emergente al volver de Cognito a /admin/callback. */
async function completePopup() {
  await waitFor(() => expect(popupUrl).toBeDefined());
  const state = new URL(popupUrl ?? '').searchParams.get('state');
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: 'oidc-client', url: `${admin.redirectUri}?code=codigo&state=${state}` },
    }),
  );
}

beforeEach(() => {
  setRuntimeConfig(config);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('acceso administrativo con Cognito', () => {
  it('usa Authorization Code + PKCE S256 en ventana emergente, sin localStorage ni sessionStorage', async () => {
    stubNetwork();
    const manager = adminUserManager(admin);
    const signin = manager.signinPopup();
    await waitFor(() => expect(popupUrl).toBeDefined());
    const url = new URL(popupUrl ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${admin.domain}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: admin.clientId,
      redirect_uri: admin.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await completePopup();
    const user = await signin;
    expect(user.access_token).toBe('token-de-acceso');
    const token = calls.find((c) => c.url.endsWith('/oauth2/token'));
    const body = new URLSearchParams(String(token?.init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(body.has('client_secret')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(calls.some((c) => c.url.includes('.well-known/openid-configuration'))).toBe(false);
  });

  it('envía el access token a la API y vuelve al inicio de sesión ante un 401', async () => {
    stubNetwork(() => 401);
    render(<AdminAccess manager={adminUserManager(admin)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    await completePopup();
    const form = await screen.findByRole('form', { name: 'Buscar expediente' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Folio exacto'), {
      target: { value: 'SINT-0001' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tu sesión terminó');
    const apiCall = calls.find((c) => c.url.startsWith(`${API}/v1/admin/patients`));
    expect(new Headers(apiCall?.init?.headers).get('authorization')).toBe('Bearer token-de-acceso');
    expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('conserva la sesión al cambiar de sección y volver (el portal se desmonta)', async () => {
    stubNetwork();
    const first = render(<AdminAccess />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    await completePopup();
    await screen.findByRole('form', { name: 'Buscar expediente' });
    first.unmount();
    render(<AdminAccess />);
    expect(await screen.findByRole('form', { name: 'Buscar expediente' })).toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('si la ventana emergente falla, lo informa y permite reintentar', async () => {
    stubNetwork();
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<AdminAccess manager={adminUserManager(admin)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ventana emergente');
  });

  it('el cierre de sesión revoca el refresh token y usa /logout de Cognito', async () => {
    stubNetwork();
    const manager = adminUserManager(admin);
    const signin = manager.signinPopup();
    await completePopup();
    await signin;
    const navigate = vi.fn();
    await adminSignOut(manager, admin, navigate);
    const revoke = calls.find((c) => c.url.endsWith('/oauth2/revoke'));
    expect(new URLSearchParams(String(revoke?.init?.body)).get('token')).toBe(
      'token-de-renovacion',
    );
    expect(await manager.getUser()).toBeNull();
    const logout = new URL(navigate.mock.calls[0]?.[0] as string);
    expect(`${logout.origin}${logout.pathname}`).toBe(`${admin.domain}/logout`);
    expect(Object.fromEntries(logout.searchParams)).toEqual({
      client_id: admin.clientId,
      logout_uri: admin.postLogoutRedirectUri,
    });
  });

  it('/admin/callback no completa nada con la configuración local', async () => {
    window.history.pushState({}, '', '/admin/callback');
    setRuntimeConfig({ stage: 'local', apiBaseUrl: '', admin: { mode: 'local' } });
    render(<App />);
    expect(await screen.findByRole('status')).toHaveTextContent('No se pudo completar');
    window.history.pushState({}, '', '/');
  });
});
