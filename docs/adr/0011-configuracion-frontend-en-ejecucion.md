# ADR-0011: Configuración del frontend en tiempo de ejecución (`config.json`)

- Estado: Aceptada (etapa 3)

## Contexto

En AWS el frontend se sirve desde CloudFront y la API vive en otro origen
(`*.execute-api.<región>.amazonaws.com/<stage>`). Las URL de la API y de Cognito solo se conocen
después de desplegar cada stack.

## Decisión

- Un único build para `dev`, `demo` y `prod`. La configuración por entorno se publica junto al build
  como `/config.json` y la aplicación la carga antes de montarse.
- `config.json` solo lleva datos públicos (stage, URL de la API, autoridad, dominio y `clientId` de
  Cognito, URL de retorno). El esquema `frontendConfigSchema` (`@eira/shared`) usa `strictObject`:
  rechaza cualquier campo adicional, como un secreto.
- El esquema exige HTTPS, que `apiBaseUrl` termine en el stage configurado, que API y Cognito estén
  en la misma región (y en dominios que la CSP de CloudFront ya permite), y que las redirecciones
  sean `<CloudFront>/admin/callback` y `<CloudFront>/admin`.
- `stage: "local"` es el único que admite la identidad administrativa sintética, y el frontend solo
  lo acepta en `127.0.0.1`/`localhost`. Un `config.json` desplegado se rechaza si su origen no
  coincide con el de la página.
- Falla cerrada: si `config.json` falta, no es JSON (CloudFront responde `index.html` ante un 404)
  o no es válido, la aplicación no arranca.
- `config.json` se genera con `npm run frontend:config` a partir de las salidas del stack guardadas
  en un archivo; el script no consulta AWS. En `vite dev` lo sirve un middleware con la
  configuración local. El build no lo incluye, y `frontend/scripts/verify-dist.ts` lo comprueba.

## Consecuencias

- Cambiar la URL de la API o de Cognito no requiere recompilar; sí volver a publicar `config.json`
  (con `Cache-Control: no-store`) e invalidar `/config.json` en CloudFront.
- Un dominio propio para la API o el frontend requerirá ampliar el esquema y la CSP.
