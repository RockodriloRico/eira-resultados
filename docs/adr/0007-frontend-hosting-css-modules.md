# ADR-0007: Hosting del frontend en S3 + CloudFront con OAC, y CSS Modules

- Estado: Aceptada

## Decisión

- La plantilla SAM define (sin desplegar):
  - un bucket S3 privado para el frontend, con Block Public Access y SSE;
  - una distribución CloudFront con **Origin Access Control**, de modo que la política del bucket solo permite `s3:GetObject` al servicio CloudFront con `AWS:SourceArn` igual a la distribución;
  - encabezados de seguridad (CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`).
- Estilos con **CSS Modules** (soporte nativo de Vite), sin framework de utilidades.

## Consecuencias

- Sin dependencias de UI adicionales; estilos con alcance local por componente.
- CSP estricta, sin `unsafe-inline`.
