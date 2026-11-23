import { describe, expect, it } from 'vitest';
import { LOCAL_FRONTEND_CONFIG, buildFrontendConfig, frontendConfigSchema } from '../src/index.ts';
import example from '../../../infrastructure/env/stack-outputs.example.json';

const valid = buildFrontendConfig('demo', example.Outputs);
const withAdmin = (patch: Record<string, unknown>) => ({
  ...valid,
  admin: { ...valid.admin, ...patch },
});
const rejects = (value: unknown) =>
  expect(frontendConfigSchema.safeParse(value).success).toBe(false);

describe('config.json del frontend', () => {
  it('se arma desde las salidas del stack, sin secretos', () => {
    expect(valid).toEqual({
      stage: 'demo',
      apiBaseUrl: 'https://abcde12345.execute-api.us-east-1.amazonaws.com/demo',
      admin: {
        mode: 'cognito',
        authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Ejemplo00',
        domain: 'https://eira-resultados-demo.auth.us-east-1.amazoncognito.com',
        clientId: '1example23456789abcdefghij',
        redirectUri: 'https://d111111abcdef8.cloudfront.net/admin/callback',
        postLogoutRedirectUri: 'https://d111111abcdef8.cloudfront.net/admin',
      },
    });
  });

  it('falla si falta una salida del stack', () => {
    const outputs = example.Outputs.filter((o) => o.OutputKey !== 'UserPoolClientId');
    expect(() => buildFrontendConfig('demo', outputs)).toThrow('UserPoolClientId');
  });

  it('rechaza campos adicionales, como un secreto de cliente', () => {
    rejects({ ...valid, apiKey: 'x' });
    rejects(withAdmin({ clientSecret: 'x' }));
  });

  it('exige HTTPS, el stage correcto y una sola región', () => {
    rejects({ ...valid, apiBaseUrl: 'http://abcde12345.execute-api.us-east-1.amazonaws.com/demo' });
    rejects({
      ...valid,
      apiBaseUrl: 'https://abcde12345.execute-api.us-east-1.amazonaws.com/prod',
    });
    rejects({ ...valid, apiBaseUrl: 'https://api.ejemplo.org/demo' });
    rejects(withAdmin({ domain: 'https://eira-resultados-demo.auth.us-west-2.amazoncognito.com' }));
    rejects(withAdmin({ authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-west-2_X' }));
  });

  it('exige redirecciones a /admin/callback y /admin en el mismo origen de CloudFront', () => {
    rejects(withAdmin({ redirectUri: 'https://atacante.example/admin/callback' }));
    rejects(withAdmin({ redirectUri: 'http://d111111abcdef8.cloudfront.net/admin/callback' }));
    rejects(withAdmin({ postLogoutRedirectUri: 'https://d222222abcdef8.cloudfront.net/admin' }));
    rejects(withAdmin({ redirectUri: 'https://d111111abcdef8.cloudfront.net/otra' }));
  });

  it('la identidad sintética solo existe con stage local, y local no acepta Cognito ni URL de API', () => {
    expect(frontendConfigSchema.parse(LOCAL_FRONTEND_CONFIG)).toEqual(LOCAL_FRONTEND_CONFIG);
    rejects({ ...valid, admin: { mode: 'local' } });
    rejects({ ...LOCAL_FRONTEND_CONFIG, admin: valid.admin });
    rejects({ ...LOCAL_FRONTEND_CONFIG, apiBaseUrl: 'http://127.0.0.1:3001' });
    rejects({ ...LOCAL_FRONTEND_CONFIG, stage: 'prod' });
  });
});
