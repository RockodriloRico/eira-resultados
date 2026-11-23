# Runbook de despliegue (propuesto)

**No ejecutar sin una autorización expresa e independiente.** El primer entorno será `demo`. El pipeline está en [deploy-pipeline.md](deploy-pipeline.md) y el rollback en [runbook-rollback.md](runbook-rollback.md).

## 0. Prerrequisitos (una vez por cuenta)

1. Revisar los costos de [costs.md](costs.md) en AWS Pricing Calculator.
2. Crear el proveedor OIDC, el rol de despliegue, el rol de ejecución de CloudFormation y el bucket de artefactos ([deploy-pipeline.md](deploy-pipeline.md)).
3. **`ManageApiGatewayAccountRole`.** `AWS::ApiGateway::Account` es un ajuste **único por cuenta y región**: el rol con el que API Gateway escribe sus logs.
   - Consultar el valor actual: `aws apigateway get-account --query cloudwatchRoleArn`.
   - **Vacío:** desplegar **un solo** stack con `ManageApiGatewayAccountRole=true`, el primero (`demo`). Los demás stacks usan `false`.
   - **Ya tiene un rol:** usar `false` en todos los stacks. El rol debe tener `AmazonAPIGatewayPushToCloudWatchLogs`.
   - Al eliminar el stack que lo creó, la cuenta conserva un ARN que ya no existe y los access logs de los demás stacks fallan. Antes de eliminarlo, apuntar la cuenta a otro rol con `aws apigateway update-account`.
   - Registrar en este runbook qué stack es el dueño del ajuste.
4. `demo`: `EnableWaf=true` y `SmsProvider=mock`, con los parámetros de cumplimiento en `false`.
5. `prod` **no se despliega** mientras no exista un proveedor SMS real (`EIRA_PROD_SMS_READY`).

## 1. Despliegue

1. Fusionar en `main` con el CI en verde.
2. _Actions → Despliegue → Run workflow_ (`stage=demo`, `confirm=demo`).
3. Aprobar el environment `demo` para crear el change set.
4. **Revisar el change set** en la consola de CloudFormation:
   - Ningún `Replacement` ni `Remove` en tablas, buckets, llaves KMS, User Pool ni secretos.
   - Cambios IAM limitados a `eira-demo-*`.
5. Aprobar `demo-apply`. Ejecuta el change set y publica el frontend con su `config.json`.

## 2. Verificación

1. **Smoke tests** (sin credenciales de AWS):
   ```
   npm run smoke -- --stage demo --api <ApiUrl> --frontend <FrontendUrl>
   ```
2. **Usuario administrador:** lo crea un administrador de la cuenta en Cognito, lo agrega al grupo `admins` y la persona activa TOTP en el primer inicio de sesión.
3. **Seed sintético:** el token se obtiene del portal administrativo, en las herramientas del navegador. Nunca se guarda en archivos.
   ```
   EIRA_ADMIN_ACCESS_TOKEN=… npm run seed:demo -- --stage demo --api <ApiUrl>
   ```
4. **Flujo de paciente:** `Ana Prueba Sintética`, `1985-03-14`, `SINT-0001`. El código aparece en pantalla porque es `demo`.
5. **Alarmas:**
   - Suscribir un correo operativo al tema `OpsAlarmsTopicArn`, solo con autorización.
   - Probar la publicación de CloudWatch: `aws cloudwatch set-alarm-state --alarm-name eira-demo-audit-write-failed --state-value ALARM --state-reason "prueba runbook"`.
   - Confirmar que el correo llega. Esto valida la condición `aws:PrincipalServiceName` de la política del tema.
6. **Prueba de tiempos** contra `demo`: ver [timing-study.md](timing-study.md).
7. Revisar el dashboard `eira-demo-operacion` y que no haya alarmas activas.

## 3. Criterio de éxito

- Smoke tests y prueba de tiempos sin fallas.
- Flujo completo de paciente y de administración con datos sintéticos.
- Alarma de prueba recibida y vuelta a `OK`.
- Auditoría sin datos personales.
