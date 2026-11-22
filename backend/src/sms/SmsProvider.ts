import { SECURITY_POLICY } from '@eira/shared';

export interface SmsProvider {
  readonly kind: 'mock' | 'sns';
  send(phone: string, message: string): Promise<void>;
}

/** Texto del SMS: solo el código. Nunca información clínica ni del resultado. */
export const pinMessage = (pin: string): string =>
  `EIRA: tu código de acceso es ${pin}. Vence en ${SECURITY_POLICY.pinTtlSeconds / 60} minutos. No lo compartas.`;

/** Proveedor de demostración: no envía nada. Guarda en memoria solo para pruebas. */
export class MockSmsProvider implements SmsProvider {
  readonly kind = 'mock' as const;
  readonly outbox: { phone: string; message: string }[] = [];
  async send(phone: string, message: string): Promise<void> {
    if (this.outbox.length >= 1000) this.outbox.shift();
    this.outbox.push({ phone, message });
  }
}

/** Integración futura. Falla de forma explícita mientras no esté aprobada. */
export class AwsSnsSmsProvider implements SmsProvider {
  readonly kind = 'sns' as const;
  async send(): Promise<void> {
    throw new Error('AwsSnsSmsProvider no está implementado');
  }
}
