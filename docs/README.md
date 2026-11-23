# Documentación

| Documento                                  | Contenido                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| [requirements.md](requirements.md)         | Versiones y requisitos de Node.js, npm, AWS SAM CLI y Docker               |
| [architecture.md](architecture.md)         | Componentes, flujo de acceso y controles de seguridad                      |
| [security-design.md](security-design.md)   | Limitación de tasa, anti-enumeración, expiración, `demoPin` y concurrencia |
| [data-model.md](data-model.md)             | Patrones de acceso y justificación de las tablas DynamoDB                  |
| [frontend-config.md](frontend-config.md)   | `config.json` por entorno: formato, generación y validaciones              |
| [observability.md](observability.md)       | Alarmas, métricas, dashboard, registro de cumplimiento y costos            |
| [deploy-pipeline.md](deploy-pipeline.md)   | Pipeline GitHub OIDC propuesto, rol, environments y procedimiento          |
| [runbook-deploy.md](runbook-deploy.md)     | Runbook de despliegue, smoke tests, seed y `ManageApiGatewayAccountRole`   |
| [runbook-rollback.md](runbook-rollback.md) | Runbook de rollback                                                        |
| [costs.md](costs.md)                       | Costos estimados por servicio y entorno                                    |
| [timing-study.md](timing-study.md)         | Prueba estadística de tiempos anti-enumeración                             |
| [adr/](adr/)                               | Decisiones de arquitectura (ADR)                                           |

Planeados: `threat-model.md` (STRIDE) y `api.md` (contrato de endpoints).
