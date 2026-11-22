import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  asArray,
  condition,
  failedRules,
  loadTemplate,
  resourcesOfType,
  statementsOf,
  type Resource,
} from './cfn.ts';

const t = loadTemplate();
const R = t.Resources;
const base = { CognitoDomainPrefix: 'eira-test' };
const json = (value: unknown) => JSON.stringify(value);
const refersTo = (value: unknown, logicalId: string) =>
  json(value).includes(`"${logicalId}"`) || json(value).includes(`\${${logicalId}`);

describe('Rules: producción no puede configurarse sin WAF ni con SMS mock', () => {
  it.each([
    [
      { Stage: 'prod', EnableWaf: 'false', SmsProvider: 'sns' },
      'Stage=prod requiere EnableWaf=true',
    ],
    [
      { Stage: 'prod', EnableWaf: 'true', SmsProvider: 'mock' },
      'Stage=prod no admite SmsProvider=mock',
    ],
  ])('rechaza %o', (params, message) => {
    expect(failedRules(t, { ...base, ...params })).toContain(message);
  });

  it('rechaza prod con los valores por defecto de SmsProvider (mock)', () => {
    expect(failedRules(t, { ...base, Stage: 'prod' })).toEqual([
      'Stage=prod no admite SmsProvider=mock',
    ]);
  });

  it.each([
    { Stage: 'prod', EnableWaf: 'true', SmsProvider: 'sns' },
    { Stage: 'dev', EnableWaf: 'false', SmsProvider: 'mock' },
    { Stage: 'demo', EnableWaf: 'true', SmsProvider: 'mock' },
    { Stage: 'demo', EnableWaf: 'false', SmsProvider: 'mock' },
  ])('acepta %o', (params) => {
    expect(failedRules(t, { ...base, ...params })).toEqual([]);
  });

  it('solo admite los entornos dev, demo y prod', () => {
    expect(t.Parameters.Stage!.AllowedValues).toEqual(['dev', 'demo', 'prod']);
    expect(() => failedRules(t, { ...base, Stage: 'staging' })).toThrow(/AllowedValues/);
  });
});

describe('Conditions', () => {
  it('CreateWaf es verdadera en prod aunque EnableWaf=false (defensa si se eliminan las Rules)', () => {
    expect(condition(t, 'CreateWaf', { ...base, Stage: 'prod', EnableWaf: 'false' })).toBe(true);
    expect(condition(t, 'CreateWaf', { ...base, Stage: 'dev', EnableWaf: 'false' })).toBe(false);
    expect(condition(t, 'CreateWaf', { ...base, Stage: 'demo', EnableWaf: 'true' })).toBe(true);
  });

  it('ExposeDemoPin solo con Stage=demo y SmsProvider=mock', () => {
    const cases: [string, string, boolean][] = [
      ['demo', 'mock', true],
      ['demo', 'sns', false],
      ['dev', 'mock', false],
      ['prod', 'mock', false],
      ['prod', 'sns', false],
    ];
    for (const [Stage, SmsProvider, expected] of cases) {
      expect(condition(t, 'ExposeDemoPin', { ...base, Stage, SmsProvider })).toBe(expected);
    }
  });

  it('WebACL y su asociación dependen de CreateWaf y la asociación apunta al stage de la API', () => {
    expect(R.ApiWebAcl).toMatchObject({ Type: 'AWS::WAFv2::WebACL', Condition: 'CreateWaf' });
    expect(R.ApiWebAclAssociation).toMatchObject({
      Type: 'AWS::WAFv2::WebACLAssociation',
      Condition: 'CreateWaf',
    });
    const arn = json(R.ApiWebAclAssociation!.Properties!.ResourceArn);
    expect(arn).toContain('/restapis/${EiraApi}/stages/${EiraApi.Stage}');
  });
});

describe('DynamoDB: cinco tablas aprobadas', () => {
  const tables: Record<string, any> = Object.fromEntries(
    resourcesOfType(t, 'AWS::DynamoDB::Table').map(([id, res]) => [id, res.Properties!]),
  );

  it('define exactamente cinco tablas y ninguna RateLimits', () => {
    expect(Object.keys(tables).sort()).toEqual([
      'AccessSessionsTable',
      'AuditLogTable',
      'PatientsTable',
      'PinChallengesTable',
      'ResultsTable',
    ]);
    expect(json(t)).not.toMatch(/RateLimits/);
  });

  it('todas usan PAY_PER_REQUEST, SSE-KMS con DataKey, retención y protección por entorno', () => {
    for (const [id, p] of Object.entries(tables)) {
      expect(p.BillingMode, id).toBe('PAY_PER_REQUEST');
      expect(p.SSESpecification, id).toEqual({
        SSEEnabled: true,
        SSEType: 'KMS',
        KMSMasterKeyId: { Ref: 'DataKey' },
      });
      expect(json(p.DeletionProtectionEnabled), id).toContain('DeletionProtection');
      expect(R[id]!.DeletionPolicy, id).toBe('Retain');
    }
    expect(t.Mappings.StageConfig!.prod!.DeletionProtection).toBe('true');
  });

  it('claves primarias e índices según el modelo de datos', () => {
    const keys = (p: any) => p.KeySchema.map((k: any) => `${k.AttributeName}:${k.KeyType}`);
    const gsis = (p: any) =>
      Object.fromEntries((p.GlobalSecondaryIndexes ?? []).map((g: any) => [g.IndexName, keys(g)]));
    expect(keys(tables.PatientsTable)).toEqual(['patientId:HASH']);
    expect(gsis(tables.PatientsTable)).toEqual({ FolioHashIndex: ['folioHash:HASH'] });
    expect(keys(tables.PinChallengesTable)).toEqual(['challengeId:HASH']);
    expect(gsis(tables.PinChallengesTable)).toEqual({});
    expect(keys(tables.AccessSessionsTable)).toEqual(['tokenHash:HASH']);
    expect(gsis(tables.AccessSessionsTable)).toEqual({});
    expect(keys(tables.ResultsTable)).toEqual(['resultId:HASH']);
    expect(gsis(tables.ResultsTable)).toEqual({
      PatientIndex: ['patientId:HASH', 'createdAt:RANGE'],
    });
    expect(keys(tables.AuditLogTable)).toEqual(['pk:HASH', 'sk:RANGE']);
    expect(gsis(tables.AuditLogTable)).toEqual({ EventTypeIndex: ['eventType:HASH', 'sk:RANGE'] });
    expect(tables.AuditLogTable.GlobalSecondaryIndexes[0].Projection.ProjectionType).toBe('ALL');
  });

  it('TTL solo en tablas efímeras y PITR en las persistentes', () => {
    const ttl = (p: any) => p.TimeToLiveSpecification;
    const pitr = (p: any) =>
      p.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled === true;
    expect(ttl(tables.PinChallengesTable)).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(ttl(tables.AccessSessionsTable)).toEqual({ AttributeName: 'ttl', Enabled: true });
    for (const id of ['PatientsTable', 'ResultsTable', 'AuditLogTable']) {
      expect(ttl(tables[id]), id).toBeUndefined();
      expect(pitr(tables[id]), id).toBe(true);
    }
  });

  it('AuditLog niega por política de recurso toda mutación o borrado de ítems', () => {
    const [statement] = tables.AuditLogTable.ResourcePolicy.PolicyDocument.Statement;
    expect(statement.Effect).toBe('Deny');
    expect(statement.Principal).toEqual({ AWS: '*' });
    expect(statement.Action.sort()).toEqual(
      [
        'dynamodb:BatchWriteItem',
        'dynamodb:DeleteItem',
        'dynamodb:PartiQLDelete',
        'dynamodb:PartiQLInsert',
        'dynamodb:PartiQLUpdate',
        'dynamodb:UpdateItem',
      ].sort(),
    );
  });
});

describe('KMS: llaves separadas para datos y documentos', () => {
  it('define dos CMK con rotación automática y retención', () => {
    const keys = resourcesOfType(t, 'AWS::KMS::Key');
    expect(keys.map(([id]) => id).sort()).toEqual(['DataKey', 'DocumentsKey']);
    for (const [id, key] of keys) {
      expect(key.Properties!.EnableKeyRotation, id).toBe(true);
      expect(key.DeletionPolicy, id).toBe('Retain');
    }
  });

  it('DynamoDB, Secrets Manager y logs usan DataKey; el bucket de documentos usa DocumentsKey', () => {
    for (const [id, secret] of resourcesOfType(t, 'AWS::SecretsManager::Secret')) {
      expect(secret.Properties!.KmsKeyId, id).toEqual({ Ref: 'DataKey' });
      expect(secret.Properties!.SecretString, id).toBeUndefined();
      expect(secret.Properties!.GenerateSecretString, id).toBeDefined();
    }
    for (const [id, group] of resourcesOfType(t, 'AWS::Logs::LogGroup')) {
      expect(group.Properties!.KmsKeyId, id).toEqual({ 'Fn::GetAtt': ['DataKey', 'Arn'] });
    }
    const sse =
      R.DocumentsBucket!.Properties!.BucketEncryption.ServerSideEncryptionConfiguration[0];
    expect(sse.ServerSideEncryptionByDefault).toEqual({
      SSEAlgorithm: 'aws:kms',
      KMSMasterKeyID: { 'Fn::GetAtt': ['DocumentsKey', 'Arn'] },
    });
    expect(json(R.DocumentsBucket)).not.toContain('DataKey');
  });

  it('DocumentsKey solo descifra para descarga y revisión, y solo genera llaves para admin-results', () => {
    const statements = R.DocumentsKey!.Properties!.KeyPolicy.Statement as any[];
    const deny = (sid: string) => statements.find((s) => s.Sid === sid);
    const roleName = (id: string) =>
      json(R[id]!.Properties!.RoleName).match(/eira-\$\{Stage\}-[a-z-]+/)![0];
    expect(deny('DecryptOnlyByReaderRoles')).toMatchObject({
      Effect: 'Deny',
      Action: 'kms:Decrypt',
    });
    const readers = deny('DecryptOnlyByReaderRoles').Condition.ArnNotEquals['aws:PrincipalArn'];
    expect(readers).toHaveLength(2);
    expect(json(readers)).toContain(`role/${roleName('DownloadUrlRole')}`);
    expect(json(readers)).toContain(`role/${roleName('AdminReviewUrlRole')}`);
    expect(deny('GenerateDataKeyOnlyByAdminResultsRole')).toMatchObject({ Effect: 'Deny' });
    expect(json(deny('GenerateDataKeyOnlyByAdminResultsRole').Condition)).toContain(
      `role/${roleName('AdminResultsRole')}`,
    );
  });
});

describe('S3 y CloudFront', () => {
  const fullBlock = {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  };

  it('ambos buckets son privados, sin ACL y con versionado', () => {
    const buckets = resourcesOfType(t, 'AWS::S3::Bucket');
    expect(buckets.map(([id]) => id).sort()).toEqual(['DocumentsBucket', 'FrontendBucket']);
    for (const [id, bucket] of buckets) {
      const p = bucket.Properties!;
      expect(p.PublicAccessBlockConfiguration, id).toEqual(fullBlock);
      expect(p.OwnershipControls.Rules, id).toEqual([{ ObjectOwnership: 'BucketOwnerEnforced' }]);
      expect(p.VersioningConfiguration.Status, id).toBe('Enabled');
      expect(p.AccessControl, id).toBeUndefined();
      expect(p.WebsiteConfiguration, id).toBeUndefined();
    }
  });

  it('las políticas niegan transporte sin TLS y no conceden acceso público', () => {
    for (const [id, policy] of resourcesOfType(t, 'AWS::S3::BucketPolicy')) {
      const statements = policy.Properties!.PolicyDocument.Statement as any[];
      expect(statements.find((s) => s.Sid === 'DenyInsecureTransport')?.Condition, id).toEqual({
        Bool: { 'aws:SecureTransport': 'false' },
      });
      for (const s of statements.filter((s) => s.Effect === 'Allow')) {
        expect(s.Principal, id).not.toBe('*');
        expect(s.Principal?.AWS, id).toBeUndefined();
      }
    }
  });

  it('el bucket de documentos exige SSE-KMS con su CMK y restringe lectura y escritura por rol', () => {
    const statements = R.DocumentsBucketPolicy!.Properties!.PolicyDocument.Statement as any[];
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));
    expect(bySid.DenyNonKmsEncryption.Condition).toEqual({
      StringNotEqualsIfExists: { 's3:x-amz-server-side-encryption': 'aws:kms' },
    });
    expect(json(bySid.DenyOtherKmsKeys.Condition)).toContain('DocumentsKey');
    // La URL de carga firma If-None-Match; el preflight del navegador debe permitirlo.
    expect(R.DocumentsBucket!.Properties!.CorsConfiguration.CorsRules[0].AllowedHeaders).toEqual(
      expect.arrayContaining(['content-type', 'if-none-match', 'x-amz-*']),
    );
    expect(bySid.DenyOverwrite).toMatchObject({
      Effect: 'Deny',
      Action: 's3:PutObject',
      Condition: { Null: { 's3:if-none-match': 'true' } },
    });
    expect(bySid.ReadOnlyByAuthorizedRoles.Effect).toBe('Deny');
    expect(
      bySid.ReadOnlyByAuthorizedRoles.Condition.ArnNotEquals['aws:PrincipalArn'].map(
        (a: any) => a['Fn::GetAtt'][0],
      ),
    ).toEqual(['DownloadUrlRole', 'AdminReviewUrlRole', 'AdminResultsRole']);
    expect(bySid.WriteOnlyByAdminResultsRole.Effect).toBe('Deny');
    expect(json(bySid.WriteOnlyByAdminResultsRole.Condition)).toContain('AdminResultsRole');
    expect(statements.filter((s) => s.Effect === 'Allow')).toEqual([]);
  });

  it('CloudFront usa OAC (SigV4 siempre), no OAI, y el bucket solo permite a esa distribución', () => {
    expect(R.FrontendOriginAccessControl!.Properties!.OriginAccessControlConfig).toMatchObject({
      OriginAccessControlOriginType: 's3',
      SigningBehavior: 'always',
      SigningProtocol: 'sigv4',
    });
    const config = R.FrontendDistribution!.Properties!.DistributionConfig;
    const [origin] = config.Origins;
    expect(origin.OriginAccessControlId).toEqual({
      'Fn::GetAtt': ['FrontendOriginAccessControl', 'Id'],
    });
    expect(origin.S3OriginConfig.OriginAccessIdentity).toBe('');
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(resourcesOfType(t, 'AWS::CloudFront::CloudFrontOriginAccessIdentity')).toEqual([]);
    const allow = (R.FrontendBucketPolicy!.Properties!.PolicyDocument.Statement as any[]).find(
      (s) => s.Effect === 'Allow',
    );
    expect(allow.Principal).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect(allow.Action).toBe('s3:GetObject');
    expect(json(allow.Condition)).toContain('distribution/${FrontendDistribution}');
  });
});

describe('API Gateway REST', () => {
  const api = R.EiraApi!.Properties!;

  it('crea la API (y con ella el stage) después de AWS::ApiGateway::Account cuando se gestiona', () => {
    expect(R.EiraApi!.DependsOn).toBe('ApiGatewayAccountReady');
    expect(R.ApiGatewayAccountReady!.Condition).toBeUndefined();
    expect(R.ApiGatewayAccountReady!.Metadata).toEqual({
      ApiGatewayAccount: {
        'Fn::If': ['CreateApiGatewayAccountRole', { Ref: 'ApiGatewayAccount' }, 'none'],
      },
    });
  });

  it('es regional, sin trazas de datos ni logs de ejecución, y con throttling por ruta', () => {
    expect(api.EndpointConfiguration).toEqual({ Type: 'REGIONAL' });
    expect(api.MethodSettings.length).toBeGreaterThan(1);
    for (const setting of api.MethodSettings) {
      expect(setting.DataTraceEnabled).toBe(false);
      expect(setting.LoggingLevel).toBe('OFF');
      expect(setting.ThrottlingRateLimit).toBeGreaterThan(0);
      expect(setting.ThrottlingBurstLimit).toBeGreaterThan(0);
      expect(setting.ResourcePath).toMatch(/^\//);
    }
  });

  it('cada ruta tiene su propio ajuste de throttling (ruta codificada con ~1)', () => {
    const configured = new Set(
      api.MethodSettings.map((m: any) => `${m.HttpMethod} ${m.ResourcePath}`),
    );
    for (const [, fn] of resourcesOfType(t, 'AWS::Serverless::Function')) {
      for (const e of Object.values<any>(fn.Properties!.Events ?? {})) {
        const path = `/${e.Properties.Path.replaceAll('/', '~1')}`;
        expect(configured, path).toContain(`${e.Properties.Method.toUpperCase()} ${path}`);
      }
    }
  });

  it('los access logs no registran cuerpos, headers ni tokens', () => {
    const format: string = api.AccessLogSetting.Format;
    expect(format).not.toMatch(/body|header|Authorization|token|apiKey/i);
  });

  it('el authorizer de sesión no usa caché', () => {
    expect(api.Auth.Authorizers.SessionAuthorizer.Identity.ReauthorizeEvery).toBe(0);
  });

  it('cada ruta tiene el authorizer esperado', () => {
    const routes = Object.fromEntries(
      resourcesOfType(t, 'AWS::Serverless::Function').flatMap(([, fn]) =>
        Object.values<any>(fn.Properties!.Events ?? {}).map((e) => [
          `${e.Properties.Method.toUpperCase()} ${e.Properties.Path}`,
          e.Properties.Auth?.Authorizer ?? 'NONE',
        ]),
      ),
    );
    expect(routes).toEqual({
      'POST /v1/access/request': 'NONE',
      'POST /v1/access/resend': 'NONE',
      'POST /v1/access/verify': 'NONE',
      'POST /v1/access/logout': 'SessionAuthorizer',
      'GET /v1/results': 'SessionAuthorizer',
      'POST /v1/results/{resultId}/download-url': 'SessionAuthorizer',
      'POST /v1/admin/patients': 'CognitoAuthorizer',
      'GET /v1/admin/patients': 'CognitoAuthorizer',
      'GET /v1/admin/patients/{patientId}': 'CognitoAuthorizer',
      'GET /v1/admin/patients/{patientId}/results': 'CognitoAuthorizer',
      'POST /v1/admin/results': 'CognitoAuthorizer',
      'POST /v1/admin/results/{resultId}/upload-url': 'CognitoAuthorizer',
      'POST /v1/admin/results/{resultId}/submit': 'CognitoAuthorizer',
      'POST /v1/admin/results/{resultId}/review': 'CognitoAuthorizer',
      'POST /v1/admin/results/{resultId}/review-url': 'CognitoAuthorizer',
      'GET /v1/admin/audit': 'CognitoAuthorizer',
    });
  });
});

describe('WAF regional', () => {
  const acl = R.ApiWebAcl!.Properties!;
  const rules: Record<string, any> = Object.fromEntries(
    (acl.Rules as any[]).map((r) => [r.Name, r]),
  );

  it('no guarda muestras de solicitudes (incluirían encabezados con tokens)', () => {
    const configs = [acl.VisibilityConfig, ...(acl.Rules as any[]).map((r) => r.VisibilityConfig)];
    for (const config of configs) {
      expect(config.SampledRequestsEnabled).toBe(false);
      expect(config.CloudWatchMetricsEnabled).toBe(true);
    }
  });

  it('incluye las reglas administradas acordadas', () => {
    expect(acl.Scope).toBe('REGIONAL');
    for (const name of [
      'AWSManagedRulesAmazonIpReputationList',
      'AWSManagedRulesKnownBadInputsRuleSet',
      'AWSManagedRulesCommonRuleSet',
    ]) {
      expect(rules[name]?.Statement.ManagedRuleGroupStatement.Name).toBe(name);
    }
  });

  it('limita por IP con respuesta 429', () => {
    const limits = Object.fromEntries(
      Object.entries(rules)
        .filter(([, r]) => r.Statement.RateBasedStatement)
        .map(([name, r]) => [name, r.Statement.RateBasedStatement]),
    );
    expect(Object.keys(limits).sort()).toEqual([
      'AccessRequestPerIp',
      'AccessVerifyPerIp',
      'GlobalPerIp',
    ]);
    expect(limits.AccessRequestPerIp).toMatchObject({
      Limit: 20,
      EvaluationWindowSec: 300,
      AggregateKeyType: 'IP',
    });
    expect(limits.AccessVerifyPerIp).toMatchObject({
      Limit: 30,
      EvaluationWindowSec: 300,
      AggregateKeyType: 'IP',
    });
    expect(limits.GlobalPerIp).toMatchObject({
      Limit: 500,
      EvaluationWindowSec: 300,
      AggregateKeyType: 'IP',
    });
    for (const name of Object.keys(limits)) {
      expect(rules[name].Action.Block.CustomResponse.ResponseCode).toBe(429);
    }
  });
});

describe('IAM: un rol por función y mínimo privilegio', () => {
  const functions = resourcesOfType(t, 'AWS::Serverless::Function');
  const roles = resourcesOfType(t, 'AWS::IAM::Role').filter(
    ([id]) => id !== 'ApiGatewayCloudWatchRole',
  );
  const roleOf = (fn: Resource) =>
    (fn.Properties!.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]!;

  it('cada una de las 11 funciones tiene su propio rol explícito', () => {
    expect(functions).toHaveLength(11);
    const used = functions.map(([, fn]) => roleOf(fn));
    expect(new Set(used).size).toBe(11);
    expect(used.sort()).toEqual(roles.map(([id]) => id).sort());
    for (const [id, fn] of functions) {
      expect(fn.Properties!.Policies, id).toBeUndefined();
    }
  });

  it('los roles solo confían en Lambda de la propia cuenta y no usan políticas administradas', () => {
    for (const [id, role] of roles) {
      const [trust] = role.Properties!.AssumeRolePolicyDocument.Statement;
      expect(trust.Principal, id).toEqual({ Service: 'lambda.amazonaws.com' });
      expect(trust.Condition, id).toEqual({
        StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
      });
      expect(role.Properties!.ManagedPolicyArns, id).toBeUndefined();
    }
  });

  it('ningún permiso usa comodines de acción o recurso ni acciones prohibidas', () => {
    const forbidden =
      /^(dynamodb:(Scan|DeleteItem|BatchWriteItem|PartiQL.*|DeleteTable|\*)|s3:\*|sns:.*|kms:\*|iam:.*|\*)$/;
    for (const [id, role] of roles) {
      for (const s of statementsOf(role)) {
        expect(s.Effect, id).toBe('Allow');
        expect(s.NotAction ?? s.NotResource, id).toBeUndefined();
        for (const action of asArray<string>(s.Action)) {
          expect(action, `${id}:${s.Sid}`).not.toMatch(forbidden);
        }
        for (const resource of asArray(s.Resource)) {
          expect(resource, `${id}:${s.Sid}`).not.toBe('*');
        }
      }
    }
  });

  it('cada rol escribe logs solo en su propio log group', () => {
    for (const [, fn] of functions) {
      const role = R[roleOf(fn)]!;
      const logs = statementsOf(role).filter((s) =>
        asArray<string>(s.Action).some((a) => a.startsWith('logs:')),
      );
      expect(logs).toHaveLength(1);
      expect(logs[0].Resource).toEqual({
        'Fn::GetAtt': [fn.Properties!.LoggingConfig.LogGroup.Ref, 'Arn'],
      });
    }
  });

  it('AuditLog: las funciones solo agregan (PutItem) y solo admin-audit consulta', () => {
    for (const [id, role] of roles) {
      for (const s of statementsOf(role).filter((s) => refersTo(s.Resource, 'AuditLogTable'))) {
        const actions = asArray<string>(s.Action);
        if (id === 'AdminAuditRole' && s.Sid === 'QueryAudit') {
          expect(actions).toEqual(['dynamodb:Query']);
        } else {
          expect(actions, id).toEqual(['dynamodb:PutItem']);
        }
      }
    }
  });

  it('el authorizer solo lee AccessSessions', () => {
    const data = statementsOf(R.SessionAuthorizerRole!).filter((s) =>
      asArray<string>(s.Action).some((a) => a.startsWith('dynamodb:')),
    );
    expect(data).toEqual([
      expect.objectContaining({
        Action: 'dynamodb:GetItem',
        Resource: { 'Fn::GetAtt': ['AccessSessionsTable', 'Arn'] },
      }),
    ]);
  });

  it('descarga y revisión no acceden a Patients; solo ellas descifran documentos', () => {
    expect(json(R.DownloadUrlRole)).not.toContain('PatientsTable');
    expect(json(R.AdminReviewUrlRole)).not.toContain('PatientsTable');
    const decryptsDocuments = (role: Resource) =>
      statementsOf(role).some(
        (s) =>
          asArray<string>(s.Action).includes('kms:Decrypt') && refersTo(s.Resource, 'DocumentsKey'),
      );
    for (const [id, role] of roles) {
      expect(decryptsDocuments(role), id).toBe(
        ['DownloadUrlRole', 'AdminReviewUrlRole'].includes(id),
      );
      const reads = statementsOf(role).some((s) =>
        asArray<string>(s.Action).includes('s3:GetObject'),
      );
      // admin-results solo verifica la carga (HeadObject) y no puede descifrar.
      expect(reads, id).toBe(
        ['DownloadUrlRole', 'AdminReviewUrlRole', 'AdminResultsRole'].includes(id),
      );
      const writes = statementsOf(role).some((s) =>
        asArray<string>(s.Action).includes('s3:PutObject'),
      );
      expect(writes, id).toBe(id === 'AdminResultsRole');
    }
  });

  it('la URL de revisión tiene función y rol propios, de solo lectura y con atributos mínimos', () => {
    const data = statementsOf(R.AdminReviewUrlRole!).filter((s) =>
      asArray<string>(s.Action).some((a) => a.startsWith('dynamodb:')),
    );
    expect(data.map((s) => s.Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem']);
    const read = data.find((s) => s.Action === 'dynamodb:GetItem');
    expect(read.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toEqual([
      'resultId',
      'patientId',
      'status',
      's3Key',
    ]);
    expect(json(R.AdminReviewUrlRole)).not.toContain('s3:PutObject');
    expect(json(R.AdminReviewUrlRole)).not.toContain('UpdateItem');
  });

  it('la lectura administrativa de Patients se limita a la vista sin hashes', () => {
    const read = statementsOf(R.AdminPatientsRole!).find((s) => s.Sid === 'ReadPatientAdminView');
    expect(read.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toEqual([
      'patientId',
      'status',
      'dataClassification',
      'phoneE164',
      'createdAt',
    ]);
  });

  it('las actualizaciones de Patients y AccessSessions se limitan a atributos concretos', () => {
    for (const [id, role] of roles) {
      for (const s of statementsOf(role)) {
        const updatesPatients =
          asArray<string>(s.Action).includes('dynamodb:UpdateItem') &&
          (refersTo(s.Resource, 'PatientsTable') || refersTo(s.Resource, 'AccessSessionsTable'));
        if (updatesPatients) {
          expect(
            s.Condition?.['ForAllValues:StringEquals']?.['dynamodb:Attributes'],
            id,
          ).toBeDefined();
        }
      }
    }
  });

  it('el uso de KMS siempre está limitado por kms:ViaService', () => {
    for (const [id, role] of roles) {
      for (const s of statementsOf(role).filter((s) =>
        asArray<string>(s.Action).some((a) => a.startsWith('kms:')),
      )) {
        expect(s.Condition?.StringEquals?.['kms:ViaService'], `${id}:${s.Sid}`).toBeDefined();
      }
    }
  });
});

describe('Lambda: esqueletos Node.js 24 / arm64', () => {
  it('runtime y arquitectura globales', () => {
    expect(t.Globals.Function.Runtime).toBe('nodejs24.x');
    expect(t.Globals.Function.Architectures).toEqual(['arm64']);
  });

  it('ninguna función sobrescribe runtime o arquitectura y todos los handlers existen', () => {
    for (const [id, fn] of resourcesOfType(t, 'AWS::Serverless::Function')) {
      expect(fn.Properties!.Runtime, id).toBeUndefined();
      expect(fn.Properties!.Architectures, id).toBeUndefined();
      const handler: string = fn.Properties!.Handler ?? t.Globals.Function.Handler;
      const file = handler.split('.')[0];
      expect(
        existsSync(new URL(`../../backend/src/handlers/${file}.ts`, import.meta.url)),
        id,
      ).toBe(true);
    }
    expect(R.SessionAuthorizerFunction!.Properties!.Handler).toBe('sessionAuthorizer.handler');
  });

  it('las rutas usan sus handlers reales', () => {
    expect(R.AccessRequestFunction!.Properties!.Handler).toBe('accessRequest.handler');
    expect(R.AccessResendFunction!.Properties!.Handler).toBe('accessResend.handler');
    expect(R.AccessVerifyFunction!.Properties!.Handler).toBe('accessVerify.handler');
    expect(R.AccessLogoutFunction!.Properties!.Handler).toBe('accessLogout.handler');
    expect(R.ListResultsFunction!.Properties!.Handler).toBe('listResults.handler');
    expect(R.DownloadUrlFunction!.Properties!.Handler).toBe('downloadUrl.handler');
  });

  it('ninguna función queda con el esqueleto notImplemented', () => {
    for (const [id, fn] of resourcesOfType(t, 'AWS::Serverless::Function')) {
      expect(fn.Properties!.Handler, id).toMatch(/^[a-zA-Z]+\.handler$/);
      expect(fn.Properties!.Handler, id).not.toBe('notImplemented.handler');
    }
  });

  it('demoPin depende de ExposeDemoPin y no hay permisos SNS', () => {
    for (const [id, fn] of resourcesOfType(t, 'AWS::Serverless::Function')) {
      const flag = fn.Properties!.Environment?.Variables?.DEMO_PIN_ENABLED;
      if (flag !== undefined)
        expect(flag, id).toEqual({ 'Fn::If': ['ExposeDemoPin', 'true', 'false'] });
    }
    expect(json(t)).not.toMatch(/"sns:/);
  });
});

describe('Outputs y configuración', () => {
  it('los outputs no exponen secretos', () => {
    const outputs = json(t.Outputs);
    expect(outputs).not.toMatch(/HmacSecret|SecretString|secretsmanager/i);
  });

  it('samconfig.toml no contiene perfiles ni credenciales y prod no desactiva WAF ni usa mock', () => {
    const samconfig = readFileSync(new URL('../samconfig.toml', import.meta.url), 'utf8');
    expect(samconfig).not.toMatch(/profile|aws_access_key|aws_secret|session_token|\b\d{12}\b/i);
    const prod = samconfig.split('[prod.deploy.parameters]')[1]!;
    const overrides = prod.match(/parameter_overrides = "([^"]+)"/)![1]!;
    const params = Object.fromEntries(overrides.split(' ').map((kv) => kv.split('=')));
    expect(params.Stage).toBe('prod');
    expect(params.EnableWaf ?? 'true').toBe('true');
    expect(params.SmsProvider).not.toBe('mock');
    expect(failedRules(t, params as Record<string, string>)).toEqual([]);
    for (const stage of ['dev', 'demo']) {
      const section = samconfig.split(`[${stage}.deploy.parameters]`)[1]!;
      const values = Object.fromEntries(
        section
          .match(/parameter_overrides = "([^"]+)"/)![1]!
          .split(' ')
          .map((kv) => kv.split('=')),
      );
      expect(failedRules(t, values as Record<string, string>), stage).toEqual([]);
    }
  });
});
