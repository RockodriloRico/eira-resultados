import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { container } from '../app/container.ts';
import { authorizerPolicy, headerValue } from '../http/patientRoutes.ts';

// 'Unauthorized' hace que API Gateway responda 401 sin invocar la ruta.
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const principal = await container().sessions.authorize(
    headerValue(event.headers, 'Authorization'),
  );
  if (!principal) throw new Error('Unauthorized');
  return authorizerPolicy(principal, event.methodArn);
};
