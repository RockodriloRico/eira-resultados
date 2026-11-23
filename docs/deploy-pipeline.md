# Pipeline de despliegue (propuesto, no habilitado)

Decisión en [ADR-0013](adr/0013-pipeline-github-oidc.md). **Nada de esto está creado.** Cada paso requiere una autorización expresa e independiente del responsable del proyecto. El primer entorno será `demo`.

## 1. Recursos que crearía un administrador de la cuenta (fuera de este repositorio)

- **Proveedor OIDC de GitHub:** `token.actions.githubusercontent.com`, audiencia `sts.amazonaws.com`.
- **Bucket de artefactos de SAM** (`SAM_ARTIFACTS_BUCKET`): privado, con SSE-KMS, versionado y expiración a 30 días.
- **Personalización del claim `sub` de GitHub** (una vez, por un administrador del repositorio): `PUT /repos/RockodriloRico/eira-resultados/actions/oidc/customization/sub` con `{"use_default": false, "include_claim_keys": ["repo", "context", "ref"]}`. Así el `sub` de un job con environment incluye la rama (`repo:RockodriloRico/eira-resultados:environment:demo:ref:refs/heads/main`) y la política de confianza exige `main` también en IAM, no solo en GitHub. Verificar el `sub` real en el primer run de `demo`.
- **Dos roles por entorno**, uno por fase. Cada uno confía solo en su environment y en `main`, así que el job `plan` no puede ejecutar change sets aunque se modifique el workflow:

| Rol                  | `sub` aceptado (`StringEquals`)                                                     | Permisos (limitados al stack `eira-resultados-<stage>`)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eira-<stage>-plan`  | `repo:RockodriloRico/eira-resultados:environment:<stage>:ref:refs/heads/main`       | `cloudformation:CreateChangeSet`, `DescribeChangeSet`, `ListChangeSets`, `DeleteChangeSet` (descarta change sets pendientes de runs anteriores), `DescribeStacks`, `DescribeStackEvents`, `GetTemplateSummary`; `CreateChangeSet` sobre la transformación `AWS::Serverless-2016-10-31`; `s3:PutObject` y `s3:GetObject` en `SAM_ARTIFACTS_BUCKET/eira-<stage>/*`; `iam:PassRole` solo para `eira-<stage>-cfn-exec` con `iam:PassedToService = cloudformation.amazonaws.com`. Sin `ExecuteChangeSet`. |
| `eira-<stage>-apply` | `repo:RockodriloRico/eira-resultados:environment:<stage>-apply:ref:refs/heads/main` | `cloudformation:DescribeChangeSet`, `ExecuteChangeSet`, `DescribeStacks`, `DescribeStackEvents`; `s3:PutObject`, `s3:DeleteObject` y `s3:ListBucket` en el bucket del frontend; `cloudfront:CreateInvalidation` en su distribución. Sin `CreateChangeSet` ni `iam:PassRole` (el change set ya lleva el rol de ejecución; confirmar en `demo` que `ExecuteChangeSet` no exige `PassRole`).                                                                                                            |

Política de confianza del rol de plan (la de apply cambia solo el environment):

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<cuenta>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:RockodriloRico/eira-resultados:environment:demo:ref:refs/heads/main"
    }
  }
}
```

- Sin comodines en `sub`: un PR, otra rama, otro repositorio o un job sin environment no pueden asumir ningún rol.
- **Rol de ejecución de CloudFormation** `eira-<stage>-cfn-exec` (obligatorio, variable `AWS_CFN_EXECUTION_ROLE_ARN`). Confía solo en `cloudformation.amazonaws.com` y tiene los permisos de creación de recursos; los roles de GitHub solo gestionan change sets, y solo el de plan le pasa este rol con `iam:PassRole`.
- La plantilla usa `CAPABILITY_NAMED_IAM`. Los permisos IAM de creación quedan en el rol de ejecución, limitados a `eira-<stage>-*`.

## 2. Configuración de GitHub (Settings)

- **Environments `demo` y `demo-apply`:**
  - _Required reviewers_: el responsable del proyecto y al menos otra persona.
  - _Prevent self-review_: quien lanza el run no puede aprobarlo. Con un solo revisor, esa persona no debe lanzar el workflow; si nadie más puede aprobar, el despliegue queda bloqueado.
  - _Deployment branches_: solo `main`.
- **Rama `main` protegida:** PR obligatorio con revisión aprobada y CI en verde, sin _force push_. Recomendado: `CODEOWNERS` para `.github/workflows/` e `infrastructure/`. El workflow que corre es el de `main`, así que esta protección es la que impide cambiar las condiciones sin revisión.
- **Variables por environment** (no en el repositorio, para que cada fase vea su propio rol):
  - `demo`: `AWS_DEPLOY_ROLE_ARN` = `eira-demo-plan`, `AWS_CFN_EXECUTION_ROLE_ARN` y `SAM_ARTIFACTS_BUCKET`.
  - `demo-apply`: `AWS_DEPLOY_ROLE_ARN` = `eira-demo-apply` y `SAM_ARTIFACTS_BUCKET`.
  - Los jobs comprueban que el rol termine en `eira-<stage>-plan` o `eira-<stage>-apply` antes de pedir credenciales.
- Al final, `EIRA_DEPLOY_ENABLED=true` en el repositorio.
- `EIRA_PROD_SMS_READY` no se define hasta que exista un proveedor SMS real.

## 3. Procedimiento de despliegue propuesto (demo)

1. Revisar y fusionar el PR en `main` con el CI en verde.
2. _Actions → Despliegue → Run workflow_, con `stage=demo` y `confirm=demo`.
3. `guard` y `build` corren sin credenciales.
4. Aprobar `demo` para crear el change set. Revisarlo en la consola de CloudFormation: no deben aparecer `Replacement` en tablas, buckets ni llaves.
5. Aprobar `demo-apply` para ejecutar el change set y publicar el frontend con su `config.json`.
6. Ejecutar los smoke tests y el seed sintético del [runbook](runbook-deploy.md).
