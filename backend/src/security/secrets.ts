import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export type Secrets = { identity: string; pin: string };
export interface SecretsProvider {
  get(): Promise<Secrets>;
}

/** Secrets Manager: se leen una vez por contenedor Lambda. */
export class AwsSecretsProvider implements SecretsProvider {
  private cached: Promise<Secrets> | undefined;
  private readonly client = new SecretsManagerClient({});
  private readonly identityArn: string;
  private readonly pinArn: string;

  constructor(identityArn: string, pinArn: string) {
    this.identityArn = identityArn;
    this.pinArn = pinArn;
  }

  get(): Promise<Secrets> {
    this.cached ??= Promise.all([this.read(this.identityArn), this.read(this.pinArn)]).then(
      ([identity, pin]) => ({ identity, pin }),
    );
    return this.cached;
  }

  private async read(arn: string): Promise<string> {
    if (!arn) return '';
    const out = await this.client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!out.SecretString) throw new Error('Secreto vacío');
    return out.SecretString;
  }
}

/** Solo local y pruebas: secretos de desarrollo generados en la máquina, nunca reales. */
export class StaticSecretsProvider implements SecretsProvider {
  private readonly secrets: Secrets;
  constructor(secrets: Secrets) {
    if (secrets.identity.length < 32 || secrets.pin.length < 32) {
      throw new Error('Los secretos locales deben tener al menos 32 caracteres');
    }
    this.secrets = secrets;
  }
  get(): Promise<Secrets> {
    return Promise.resolve(this.secrets);
  }
}
