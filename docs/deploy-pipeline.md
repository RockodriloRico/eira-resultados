# Pipeline de despliegue (propuesto, no habilitado)

Decisión en [ADR-0013](adr/0013-pipeline-github-oidc.md). **Nada de esto está creado.** Cada paso requiere una autorización expresa e independiente del responsable del proyecto. El primer entorno será `demo`.

## 1. Recursos que crearía un administrador de la cuenta (fuera de este repositorio)

- **Proveedor OIDC de GitHub:** `token.actions.githubusercontent.com`, audiencia `sts.amazonaws.com`.
- **Bucket de artefactos de SAM** (`SAM_ARTIFACTS_BUCKET`): privado, con SSE-KMS, versionado y expiración a 30 días.
- **Rol `eira-<stage>-deploy`**, uno por entorno, con esta política de confianza:

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
      "token.actions.githubusercontent.com:sub": [
        "repo:RockodriloRico/eira-resultados:environment:demo",
        "repo:RockodriloRico/eira-resultados:environment:demo-apply"
      ]
    }
  }
}
```

- **Permisos del rol** (borrador, limitado al stack `eira-resultados-<stage>`):
  - `cloudformation:CreateChangeSet`, `DescribeChangeSet`, `ListChangeSets`, `DeleteChangeSet` (para descartar change sets pendientes de runs anteriores), `ExecuteChangeSet`, `DescribeStacks`, `DescribeStackEvents` y `GetTemplateSummary` sobre el stack. Además, `CreateChangeSet` sobre la transformación `AWS::Serverless-2016-10-31`.
  - `s3:PutObject` y `s3:GetObject` en `SAM_ARTIFACTS_BUCKET/eira-<stage>/*`.
  - `s3:PutObject`, `s3:DeleteObject` y `s3:ListBucket` en el bucket del frontend, y `cloudfront:CreateInvalidation` en su distribución.
  - `iam:PassRole` solo para `eira-<stage>-cfn-exec`, con `iam:PassedToService = cloudformation.amazonaws.com`.
  - **Rol de ejecución de CloudFormation** `eira-<stage>-cfn-exec` (obligatorio, variable `AWS_CFN_EXECUTION_ROLE_ARN`). Confía solo en `cloudformation.amazonaws.com` y tiene los permisos de creación de recursos; el rol de GitHub solo gestiona change sets y le pasa este rol con `iam:PassRole`.
- La plantilla usa `CAPABILITY_NAMED_IAM`. Los permisos IAM de creación quedan en el rol de ejecución, limitados a `eira-<stage>-*`.

## 2. Configuración de GitHub (Settings)

- **Environments `demo` y `demo-apply`:**
  - _Required reviewers_: el responsable del proyecto.
  - _Prevent self-review_.
  - _Deployment branches_: solo `main`.
- **Variables:** `AWS_DEPLOY_ROLE_ARN`, `AWS_CFN_EXECUTION_ROLE_ARN` y `SAM_ARTIFACTS_BUCKET`, en el repositorio o en los environments `<stage>` y `<stage>-apply`. Al final, `EIRA_DEPLOY_ENABLED=true` en el repositorio.
- `EIRA_PROD_SMS_READY` no se define hasta que exista un proveedor SMS real.

## 3. Procedimiento de despliegue propuesto (demo)

1. Revisar y fusionar el PR en `main` con el CI en verde.
2. _Actions → Despliegue → Run workflow_, con `stage=demo` y `confirm=demo`.
3. `guard` y `build` corren sin credenciales.
4. Aprobar `demo` para crear el change set. Revisarlo en la consola de CloudFormation: no deben aparecer `Replacement` en tablas, buckets ni llaves.
5. Aprobar `demo-apply` para ejecutar el change set y publicar el frontend con su `config.json`.
6. Ejecutar los smoke tests y el seed sintético del [runbook](runbook-deploy.md).
