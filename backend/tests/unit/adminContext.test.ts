import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { adminContext, cognitoGroups } from '../../src/http/responses.ts';

const event = (claims: Record<string, unknown> | undefined) =>
  ({
    requestContext: { authorizer: claims ? { claims } : null },
  }) as unknown as APIGatewayProxyEvent;

describe('identidad administrativa (Cognito)', () => {
  it('lee cognito:groups en los formatos que entrega el authorizer', () => {
    expect(cognitoGroups('admins')).toEqual(['admins']);
    expect(cognitoGroups('otros,admins')).toEqual(['otros', 'admins']);
    expect(cognitoGroups('[otros admins]')).toEqual(['otros', 'admins']);
    expect(cognitoGroups(['admins', 3])).toEqual(['admins']);
    expect(cognitoGroups(undefined)).toEqual([]);
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
