import type { CognitoAdminConfig } from '@eira/shared';
import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';

/**
 * Cliente OIDC del portal administrativo (ADR-0006): Authorization Code + PKCE (S256) contra el
 * Hosted UI de Cognito, en ventana emergente. Tokens y estado PKCE viven solo en memoria: la
 * página principal no navega, así que no hace falta localStorage ni sessionStorage. Al recargar
 * hay que iniciar sesión de nuevo.
 */
export function adminUserManager(config: CognitoAdminConfig): UserManager {
  const memory = () => new WebStorageStateStore({ store: new InMemoryWebStorage() });
  return new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    popup_redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    response_type: 'code',
    scope: 'openid email',
    userStore: memory(),
    stateStore: memory(),
    loadUserInfo: false,
    monitorSession: false,
    // Renovación solo con refresh token (en memoria); sin iframes, que la CSP no permite.
    automaticSilentRenew: true,
    revokeTokenTypes: ['refresh_token'],
    // Metadatos explícitos: sin fetch al discovery de Cognito.
    metadata: {
      issuer: config.authority,
      authorization_endpoint: `${config.domain}/oauth2/authorize`,
      token_endpoint: `${config.domain}/oauth2/token`,
      revocation_endpoint: `${config.domain}/oauth2/revoke`,
      userinfo_endpoint: `${config.domain}/oauth2/userInfo`,
      jwks_uri: `${config.authority}/.well-known/jwks.json`,
    },
  });
}

/**
 * Cierre de sesión: revoca el refresh token, descarta los tokens en memoria y borra la sesión del
 * Hosted UI con el endpoint `/logout` de Cognito (`client_id` + `logout_uri`).
 */
export async function adminSignOut(
  manager: UserManager,
  config: CognitoAdminConfig,
  navigate: (url: string) => void = (url) => window.location.assign(url),
) {
  await manager.revokeTokens(['refresh_token']).catch(() => undefined);
  await manager.removeUser();
  const url = new URL(`${config.domain}/logout`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', config.postLogoutRedirectUri);
  navigate(url.toString());
}

export const isAdminCallback = (location: Location = window.location) =>
  location.pathname === '/admin/callback';
