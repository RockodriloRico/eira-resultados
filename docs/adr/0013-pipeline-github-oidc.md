# ADR-0013: Pipeline de despliegue con GitHub Actions y OIDC (definido, sin capacidad efectiva)

- Estado: Aceptada (etapa 3, decisión 4)

## Decisión

- `.github/workflows/deploy.yml` se ejecuta **solo a mano** (`workflow_dispatch`) y desde `main`. Hay que escribir el nombre del entorno para confirmar.
- Tiene cuatro jobs encadenados:
  1. **`guard`:** sin permisos de AWS. Falla mientras la variable del repositorio `EIRA_DEPLOY_ENABLED` no sea `true`. `plan` y `apply` fallan antes de pedir credenciales si no ven `AWS_DEPLOY_ROLE_ARN` y `SAM_ARTIFACTS_BUCKET`, que pueden definirse en el repositorio o en cada environment. En `prod` también exige `EIRA_PROD_SMS_READY=true`, que no existirá hasta que haya un proveedor SMS real.
  2. **`build`:** sin credenciales. Ejecuta `npm run check`, `sam validate --lint` y `sam build`.
  3. **`plan`:** environment `<stage>` con aprobación manual. Usa OIDC y `sam deploy --no-execute-changeset`, así que solo crea el _change set_.
  4. **`apply`:** environment `<stage>-apply`, con una segunda aprobación manual. Ejecuta el change set, genera `config.json` desde los outputs y publica el frontend.
- **Sin credenciales permanentes:** AWS solo se alcanza con `aws-actions/configure-aws-credentials` y el rol de OIDC. Ningún workflow usa `secrets.*` de AWS.
- **Acciones fijadas a SHA** en todos los workflows.
- **CI sin capacidad de despliegue:** CI no tiene `id-token` ni pasos de despliegue.
- Pruebas: `infrastructure/tests/workflows.test.ts`.

## Estado actual: sin capacidad efectiva

- No existen el rol IAM, el proveedor OIDC, el bucket de artefactos, las variables ni los environments. El job `guard` falla siempre.
- Habilitarlo requiere una **autorización independiente** y los pasos de [deploy-pipeline.md](../deploy-pipeline.md).

## Consecuencias

- Cada despliegue necesita dos aprobaciones humanas: la del change set y la de su ejecución.
- `apply` ejecuta el último change set `CREATE_COMPLETE` del stack. El runbook pide revisarlo en la consola entre ambas aprobaciones.
