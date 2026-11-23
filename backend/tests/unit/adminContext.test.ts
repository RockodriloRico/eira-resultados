import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { adminContext, isAdminGroupClaim } from '../../src/http/responses.ts';

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
    expect(adminContext(event({ sub: 'u1', 'cognito:groups': 'admins' }))).toEqual({
      adminId: 'u1',
    });
    expect(() => adminContext(event(undefined))).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(() => adminContext(event({ sub: 'u1' }))).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(() => adminContext(event({ sub: 'u1', 'cognito:groups': 'adminsx' }))).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});
