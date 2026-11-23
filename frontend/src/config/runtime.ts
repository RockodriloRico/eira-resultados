import { type FrontendConfig, frontendConfigSchema } from '@eira/shared';

let current: FrontendConfig | undefined;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * Carga y valida /config.json antes de montar la aplicación. Si falta o no es válido (CloudFront
 * responde index.html ante un 404), la aplicación no arranca: falla cerrada.
 */
export async function loadRuntimeConfig(location: Location = window.location) {
  const res = await fetch('/config.json', { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error('config.json no disponible');
  const config = frontendConfigSchema.parse(await res.json());
  if (config.stage === 'local' && !LOCAL_HOSTS.has(location.hostname))
    throw new Error('La configuración local solo se acepta en 127.0.0.1');
  if (
    config.admin.mode === 'cognito' &&
    new URL(config.admin.redirectUri).origin !== location.origin
  )
    throw new Error('config.json corresponde a otro origen');
  current = config;
  return config;
}

export function setRuntimeConfig(config: FrontendConfig) {
  current = config;
}

export function runtimeConfig(): FrontendConfig {
  if (!current) throw new Error('Configuración no cargada');
  return current;
}
