# Costos estimados por servicio y entorno

Estimación en USD al mes para `us-east-1`, con precios de lista públicos de AWS a la fecha de la etapa 3, **sin el nivel gratuito** y con tráfico bajo. **Aproximada**: recalcular con AWS Pricing Calculator antes de cada despliegue autorizado.

Supuestos:

- `dev`: uso del equipo y sin WAF.
- `demo`: hasta unas 5000 solicitudes al mes, con WAF.
- `prod`: hasta unas 100 000 solicitudes al mes, con WAF y todo el registro de cumplimiento activado.

| Servicio                                                                    | dev        | demo       | prod       | Base                                           |
| --------------------------------------------------------------------------- | ---------- | ---------- | ---------- | ---------------------------------------------- |
| API Gateway REST                                                            | < 0.10     | < 0.10     | ~0.35      | 3.50 por millón de solicitudes                 |
| Lambda (arm64, 11 funciones)                                                | < 0.10     | < 0.10     | < 1        | Por solicitud y GB-s                           |
| DynamoDB on-demand y PITR (5 tablas)                                        | < 0.50     | < 0.50     | 1–2        | Lecturas y escrituras, más 0.20/GB-mes de PITR |
| S3 (documentos y frontend)                                                  | < 0.10     | < 0.10     | < 1        | 0.023/GB-mes más solicitudes                   |
| CloudFront                                                                  | < 0.10     | < 0.50     | 1–2        | Transferencia y solicitudes                    |
| KMS (3 CMK)                                                                 | 3.00       | 3.00       | 3.00–4.00  | 1.00 por CMK, más 0.03 por 10 000 solicitudes  |
| Secrets Manager (2 secretos)                                                | 0.80       | 0.80       | 0.80       | 0.40 por secreto                               |
| Cognito (personal administrativo)                                           | ~0         | ~0         | ~0         | Pocos usuarios activos al mes                  |
| WAF (Web ACL y reglas administradas)                                        | —          | ~11        | ~11–12     | 5.00 por ACL, 1.00 por regla y 0.60 por millón |
| CloudWatch Logs (Lambda y API)                                              | < 1        | < 1        | 1–3        | 0.50/GB de ingesta                             |
| Observabilidad: alarmas, métricas y dashboard ([detalle](observability.md)) | 6–9        | 6–9        | 6–9        |                                                |
| Registro de cumplimiento: WAF, S3, CloudTrail y Config                      | —          | —          | 4–10       |                                                |
| SNS (correo de alarmas)                                                     | ~0         | ~0         | ~0         |                                                |
| **Total aproximado**                                                        | **~11–15** | **~22–27** | **~31–46** |                                                |

Sin incluir:

- **SMS real:** sin proveedor en esta etapa. Con SNS en México, el costo por mensaje se cotiza aparte.
- **Infraestructura del pipeline:** bucket de artefactos y GitHub Actions, menos de 1.
- Soporte de AWS e impuestos.
