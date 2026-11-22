import { afterEach, describe, expect, it } from 'vitest';
import { authorizerPolicy, headerValue } from '../src/http/patientRoutes.ts';
import { handler as notImplemented } from '../src/handlers/notImplemented.ts';

describe('handlers Lambda', () => {
  afterEach(() => {
    delete process.env.CORS_ALLOWED_ORIGIN;
  });

  it('notImplemented responde 501 sin caché', async () => {
    const res = await notImplemented();
    expect(res.statusCode).toBe(501);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store' });
    expect(JSON.parse(res.body)).toEqual({ message: 'No implementado' });
  });

  it('notImplemented agrega CORS solo con el origen configurado', async () => {
    expect((await notImplemented()).headers).not.toHaveProperty('Access-Control-Allow-Origin');
    process.env.CORS_ALLOWED_ORIGIN = 'https://example.cloudfront.net';
    expect((await notImplemented()).headers).toMatchObject({
      'Access-Control-Allow-Origin': 'https://example.cloudfront.net',
    });
  });

  it('el authorizer permite solo el método invocado y pasa el contexto de sesión', () => {
    const methodArn = 'arn:aws:execute-api:us-east-1:000000000000:api/dev/GET/v1/results';
    const res = authorizerPolicy({ patientId: 'pat_x', tokenHash: 'h' }, methodArn);
    expect(res.policyDocument.Statement).toEqual([
      { Action: 'execute-api:Invoke', Effect: 'Allow', Resource: methodArn },
    ]);
    expect(res.context).toEqual({ patientId: 'pat_x', tokenHash: 'h' });
  });

  it('el encabezado Authorization se lee sin distinguir mayúsculas', () => {
    expect(headerValue({ authorization: 'Bearer x' }, 'Authorization')).toBe('Bearer x');
    expect(headerValue(null, 'Authorization')).toBeUndefined();
  });
});
