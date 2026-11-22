# ADR-0010: Estados de resultados y revisión administrativa

Estado: **Aceptada** (etapa 2).

## Contexto

La paciente solo debe ver documentos revisados. EIRA no interpreta ni valida clínicamente los resultados; la revisión administrativa comprueba correspondencia (documento ↔ expediente), integridad (SHA-256) y legibilidad.

## Decisión

```text
CREATED ──SUBMIT_DOCUMENT──▶ PENDING_REVIEW ──APPROVE──▶ APPROVED (visible para la paciente)
                                   │
                                   └──REQUEST_CORRECTION──▶ CORRECTION_REQUESTED ──SUBMIT_DOCUMENT──▶ PENDING_REVIEW
```

- La tabla de transiciones vive en `packages/shared/src/resultStatus.ts`; cualquier otra transición se rechaza con `409`.
- Cada transición es un `UpdateItem` con `ConditionExpression` `#status = :origen AND #version = :version`: si dos administradores actúan a la vez, solo una escritura se aplica.
- Aprobar exige marcar las tres revisiones; solicitar corrección exige un motivo.
- `APPROVED` es terminal en el MVP.
- La visualización administrativa del PDF solo se permite en `PENDING_REVIEW`, con URL firmada de 60 s emitida por una Lambda y un rol propios y auditada (`REVIEW_URL_ISSUED`). Se implementa en la entrega 4.

## Consecuencias

- `Results` gana los atributos `version`, `sizeBytes`, `sha256`, `reviewedBy`, `reviewNote`, `updatedAt`. No cambian claves ni índices.
- `PatientIndex` sigue sin proyectar `s3Key`: listar resultados nunca revela la ubicación del documento.
