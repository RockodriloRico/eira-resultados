import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { afterEach, describe, expect, it } from 'vitest';
import { handler as denyAll } from '../src/handlers/denyAllAuthorizer.ts';
import { handler as notImplemented } from '../src/handlers/notImplemented.ts';

describe('esqueletos Lambda (etapa 1)', () => {
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

  it('el authorizer esqueleto siempre deniega', async () => {
    const methodArn = 'arn:aws:execute-api:us-east-1:000000000000:api/dev/GET/v1/results';
    const res = await denyAll({ methodArn } as APIGatewayRequestAuthorizerEvent);
    expect(res.policyDocument.Statement).toEqual([
      { Action: 'execute-api:Invoke', Effect: 'Deny', Resource: methodArn },
    ]);
  });
});
