import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  adminContext,
  adminTokenExpectations,
  isAdminGroupClaim,
} from '../../src/http/responses.ts';

const expected = {
  clientId: 'cliente-admin',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Prueba',
};
const valid = {
  sub: 'u1',
  'cognito:groups': 'admins',
  token_use: 'access',
  client_id: expected.clientId,
  iss: expected.issuer,
};
const event = (claims: Record<string, unknown> | undefined) =>
  ({
    requestContext: { authorizer: claims ? { claims } : null },
  }) as unknown as APIGatewayProxyEvent;

describe('identidad administrativa (Cognito)', () => {
  it('acepta solo el grupo admins exacto, sin separar nombres con comas o espacios', () => {
    expect(isAdminGroupClaim('admins')).toBe(true);
    expect(isAdminGroupClaim('[admins]')).toBe(true);
    expect(isAdminGroupClaim(['admins'])).toBe(true);
    for (const value of [
      'operadores,admins',
      '[operadores admins]',
      'admins,otros',
      ' admins',
      'adminsx',
      ['admins', 'otros'],
      ['operadores,admins'],
      '',
      undefined,
      null,
    ])
      expect(isAdminGroupClaim(value)).toBe(false);
  });

  it('exige sub (401) y el grupo admins (403)', () => {
    expect(adminContext(event(valid), expected)).toEqual({ adminId: 'u1' });
    expect(() => adminContext(event(undefined), expected)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(() => adminContext(event({ ...valid, 'cognito:groups': undefined }), expected)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(() => adminContext(event({ ...valid, 'cognito:groups': 'adminsx' }), expected)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it.each([
    ['un ID token', { token_use: 'id' }],
    ['sin token_use', { token_use: undefined }],
    ['otro cliente del User Pool', { client_id: 'otro-cliente' }],
    ['sin client_id (ID token)', { client_id: undefined, aud: expected.clientId }],
    ['otro emisor', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Otro' }],
  ])('rechaza con 401 %s', (_, override) => {
    expect(() => adminContext(event({ ...valid, ...override }), expected)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('falla cerrada en Lambda si faltan el cliente o el emisor esperados', () => {
    expect(adminTokenExpectations({ AWS_LAMBDA_FUNCTION_NAME: 'f' })).toBeUndefined();
    expect(
      adminTokenExpectations({ AWS_LAMBDA_FUNCTION_NAME: 'f', ADMIN_CLIENT_ID: 'c' }),
    ).toBeUndefined();
    expect(() => adminContext(event(valid), undefined)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(
      adminTokenExpectations({
        AWS_LAMBDA_FUNCTION_NAME: 'f',
        ADMIN_CLIENT_ID: 'c',
        ADMIN_TOKEN_ISSUER: 'i',
      }),
    ).toEqual({ clientId: 'c', issuer: 'i' });
  });
});
