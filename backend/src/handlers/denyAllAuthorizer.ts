import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';

// Esqueleto de etapa 1: deniega toda solicitud hasta que exista la validación de sesiones.
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => ({
  principalId: 'anonymous',
  policyDocument: {
    Version: '2012-10-17',
    Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: event.methodArn }],
  },
});
