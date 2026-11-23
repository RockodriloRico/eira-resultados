# Configuración del frontend por entorno

Decisión: [ADR-0011](adr/0011-configuracion-frontend-en-ejecucion.md). Esquema:
`packages/shared/src/frontendConfig.ts`.

## Formato

```json
{
  "stage": "demo",
  "apiBaseUrl": "https://abcde12345.execute-api.us-east-1.amazonaws.com/demo",
  "admin": {
    "mode": "cognito",
    "authority": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Ejemplo00",
    "domain": "https://eira-resultados-demo.auth.us-east-1.amazoncognito.com",
    "clientId": "1example23456789abcdefghij",
    "redirectUri": "https://d111111abcdef8.cloudfront.net/admin/callback",
    "postLogoutRedirectUri": "https://d111111abcdef8.cloudfront.net/admin"
  }
}
```

Los valores son ficticios. En local, Vite sirve
`{"stage":"local","apiBaseUrl":"","admin":{"mode":"local"}}` y la API se alcanza por proxy.

## Generación (sin consultar AWS)

El script lee un archivo con las salidas del stack (formato de `describe-stacks`; acepta
`Stacks[0].Outputs`, `Outputs` o el arreglo directo) y escribe `config.json` validado:

```sh
npm run build -w @eira/frontend
npm run frontend:config -- --stage demo \
  --outputs infrastructure/env/stack-outputs.example.json --out frontend/dist/config.json
```

Salidas usadas: `ApiUrl`, `FrontendUrl`, `UserPoolId`, `UserPoolClientId` y `CognitoDomain`.

## Validaciones

| Dónde                              | Qué comprueba                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Esquema (`@eira/shared`)           | Sin campos extra; HTTPS; stage de la URL = `stage`; una sola región; redirecciones en el mismo origen de CloudFront; modo local solo con `stage: "local"` |
| Frontend al arrancar               | Configuración local solo en `127.0.0.1`/`localhost`; configuración desplegada solo en su propio origen; falla cerrada si falta o es inválida              |
| `npm run build` (`verify-dist.ts`) | El build no trae `config.json`, source maps, scripts en línea ni marcas locales (`127.0.0.1:3001`, identidad sintética, folios `SINT-`)                   |
