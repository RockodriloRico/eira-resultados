import type { APIGatewayProxyResult } from 'aws-lambda';

// Esqueleto de etapa 1: ninguna ruta tiene lógica de negocio todavía.
export const handler = async (): Promise<APIGatewayProxyResult> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const origin = process.env.CORS_ALLOWED_ORIGIN;
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return {
    statusCode: 501,
    headers,
    body: JSON.stringify({ message: 'No implementado' }),
  };
};
