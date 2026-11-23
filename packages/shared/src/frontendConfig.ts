import { z } from 'zod';

/**
 * Configuración del frontend en tiempo de ejecución (`/config.json`). Un mismo build sirve para
 * todos los entornos. Solo contiene datos públicos: el cliente de Cognito no tiene secreto y
 * `strictObject` rechaza cualquier campo adicional.
 */
export const DEPLOYED_STAGES = ['dev', 'demo', 'prod'] as const;
export type DeployedStage = (typeof DEPLOYED_STAGES)[number];

const REGION = '[a-z]{2}(?:-[a-z]+)+-\\d';
const API_BASE_URL = new RegExp(
  `^https://[a-z0-9]{10}\\.execute-api\\.(${REGION})\\.amazonaws\\.com/(dev|demo|prod)$`,
);
const COGNITO_AUTHORITY = new RegExp(
  `^https://cognito-idp\\.(${REGION})\\.amazonaws\\.com/(${REGION})_[A-Za-z0-9]{1,32}$`,
);
const COGNITO_DOMAIN = new RegExp(
  `^https://[a-z0-9-]{1,63}\\.auth\\.(${REGION})\\.amazoncognito\\.com$`,
);
const CLOUDFRONT_URL = /^https:\/\/[a-z0-9]+\.cloudfront\.net$/;

const localConfig = z.strictObject({
  stage: z.literal('local'),
  apiBaseUrl: z.literal(''),
  admin: z.strictObject({ mode: z.literal('local') }),
});

const deployedConfig = z
  .strictObject({
    stage: z.enum(DEPLOYED_STAGES),
    apiBaseUrl: z.string().regex(API_BASE_URL),
    admin: z.strictObject({
      mode: z.literal('cognito'),
      authority: z.string().regex(COGNITO_AUTHORITY),
      domain: z.string().regex(COGNITO_DOMAIN),
      clientId: z.string().regex(/^[A-Za-z0-9]{1,128}$/),
      redirectUri: z.string(),
      postLogoutRedirectUri: z.string(),
    }),
  })
  .superRefine((config, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const api = API_BASE_URL.exec(config.apiBaseUrl);
    const authority = COGNITO_AUTHORITY.exec(config.admin.authority);
    const domain = COGNITO_DOMAIN.exec(config.admin.domain);
    if (api?.[2] !== config.stage) issue('apiBaseUrl debe apuntar al stage configurado');
    const regions = new Set([api?.[1], authority?.[1], authority?.[2], domain?.[1]]);
    if (regions.size !== 1) issue('API y Cognito deben estar en la misma región');
    const redirect = config.admin.redirectUri.match(/^(https:\/\/[^/]+)\/admin\/callback$/);
    const logout = config.admin.postLogoutRedirectUri.match(/^(https:\/\/[^/]+)\/admin$/);
    if (!redirect?.[1] || !CLOUDFRONT_URL.test(redirect[1]))
      issue('redirectUri debe ser <frontend>/admin/callback en CloudFront');
    if (!logout || logout[1] !== redirect?.[1])
      issue('postLogoutRedirectUri debe ser <frontend>/admin en el mismo origen');
  });

export const frontendConfigSchema = z.union([localConfig, deployedConfig]);
export type FrontendConfig = z.infer<typeof frontendConfigSchema>;
export type CognitoAdminConfig = Extract<FrontendConfig['admin'], { mode: 'cognito' }>;

export const LOCAL_FRONTEND_CONFIG: FrontendConfig = Object.freeze({
  stage: 'local',
  apiBaseUrl: '',
  admin: Object.freeze({ mode: 'local' }),
}) as FrontendConfig;

type StackOutputs = readonly { OutputKey?: string; OutputValue?: string }[];

/** Arma el config.json a partir de las salidas del stack (`describe-stacks` → `Outputs`). */
export function buildFrontendConfig(stage: DeployedStage, outputs: StackOutputs): FrontendConfig {
  const values = new Map(outputs.map((o) => [o.OutputKey, o.OutputValue]));
  const get = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`Falta la salida ${key} del stack`);
    return value;
  };
  const poolId = get('UserPoolId');
  const region = poolId.split('_')[0];
  const frontend = get('FrontendUrl');
  return frontendConfigSchema.parse({
    stage,
    apiBaseUrl: get('ApiUrl'),
    admin: {
      mode: 'cognito',
      authority: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
      domain: get('CognitoDomain'),
      clientId: get('UserPoolClientId'),
      redirectUri: `${frontend}/admin/callback`,
      postLogoutRedirectUri: `${frontend}/admin`,
    },
  });
}
