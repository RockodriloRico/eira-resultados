# Runbook de rollback (propuesto)

## Principios

- **Los datos no se revierten.** Tablas, buckets, llaves KMS, User Pool y secretos tienen `DeletionPolicy: Retain` y no se borran ni se reemplazan al revertir.
- **Revertir es desplegar otra vez**, con el mismo pipeline y las mismas dos aprobaciones, a partir del commit anterior de `main`.
- Nunca usar `delete-stack` como rollback.

## 1. Fallo durante la ejecución del change set

CloudFormation revierte solo al estado anterior (`UPDATE_ROLLBACK_COMPLETE`), y `apply` falla antes de publicar el frontend. Después:

1. Revisar los eventos del stack (`describe-stack-events`) y corregir en un PR nuevo.
2. Si el stack queda en `UPDATE_ROLLBACK_FAILED`, ejecutar `aws cloudformation continue-update-rollback`, saltando solo recursos sin datos y documentando el motivo.
3. En un **primer** despliegue fallido (`ROLLBACK_COMPLETE`), eliminar el stack vacío. Los recursos con `Retain` quedan huérfanos y hay que revisarlos a mano antes de reintentar.

## 2. Regresión detectada después del despliegue

1. `git revert` del merge en `main`, con un PR y CI en verde.
2. Ejecutar el workflow y revisar que el change set solo deshaga los cambios esperados.
3. Aprobar `apply`. El frontend anterior se vuelve a publicar con su `config.json` y se invalida CloudFront.
4. Ejecutar los smoke tests.

## 3. Solo frontend

Los objetos del bucket del frontend tienen versionado, así que se puede volver a publicar el `frontend/dist` del commit anterior (paso 2). Restaurar versiones de S3 a mano solo en una emergencia, invalidando `/*` después.

## 4. Incidente de seguridad

1. Activar o ajustar las reglas de WAF, o bajar el throttling del stage.
2. **Revocar sesiones:**
   - Pacientes: rotar el secreto del PIN y la identidad invalida retos y búsquedas. Las sesiones vigentes se revocan en `AccessSessions` y vencen en 15 minutos de todos modos.
   - Administración: `admin-user-global-sign-out` en Cognito.
3. Conservar los logs y la auditoría, que son append-only, y registrar el incidente.
