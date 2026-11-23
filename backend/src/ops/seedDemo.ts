import { createHash } from 'node:crypto';
import { SYNTHETIC_PATIENTS, SYNTHETIC_RESULTS } from '../local/syntheticData.ts';
import { syntheticPdf } from '../local/syntheticPdf.ts';

/**
 * Seed exclusivamente sintético mediante la API administrativa (ADR-0014): los mismos endpoints,
 * permisos y auditoría que el portal. Nunca escribe directamente en DynamoDB ni S3.
 */
export type SeedOptions = {
  apiUrl: string;
  stage: 'local' | 'dev' | 'demo' | 'prod';
  /** Access token de Cognito del personal (grupo admins). Sin token solo funciona en local. */
  accessToken?: string;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
};

type ApiBody = {
  patientId?: string;
  resultId?: string;
  url?: string;
  headers?: Record<string, string>;
  results?: { sampleDate: string; status: string }[];
};

export async function seedSyntheticViaApi(options: SeedOptions): Promise<{ created: number }> {
  if (options.stage === 'prod') throw new Error('El seed sintético no se ejecuta en prod');
  if (options.stage !== 'local' && !options.accessToken)
    throw new Error('Se requiere el access token de Cognito del personal administrativo');
  assertApiMatchesStage(options.apiUrl, options.stage);
  for (const p of SYNTHETIC_PATIENTS)
    if (!p.folio.startsWith('SINT-')) throw new Error('Solo se admiten folios sintéticos');
  const doFetch = options.fetchFn ?? fetch;
  const log = options.log ?? (() => undefined);
  const api = options.apiUrl.replace(/\/$/, '');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await doFetch(`${api}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as ApiBody };
  };

  let created = 0;
  for (const patient of SYNTHETIC_PATIENTS) {
    const res = await call('POST', '/v1/admin/patients', patient);
    if (res.status === 201) created++;
    else if (res.status !== 409) throw new Error(`Alta ${patient.folio}: ${res.status}`);
    log(`${patient.folio}: ${res.status === 201 ? 'creado' : 'ya existía'}`);
  }
  for (const result of SYNTHETIC_RESULTS) {
    const patient = await call('GET', `/v1/admin/patients?folio=${result.folio}`);
    const existing = await call('GET', `/v1/admin/patients/${patient.body.patientId!}/results`);
    const expected = result.approved ? 'APPROVED' : 'PENDING_REVIEW';
    const previous = existing.body.results?.find((r) => r.sampleDate === result.sampleDate);
    if (previous) {
      // Un resultado a medias de una ejecución anterior no se reporta como sembrado.
      if (previous.status !== expected)
        throw new Error(
          `${result.folio} ${result.sampleDate}: quedó en ${previous.status}; complétalo en el portal`,
        );
      log(`${result.folio} ${result.sampleDate}: ya existía`);
      continue;
    }
    const res = await call('POST', '/v1/admin/results', {
      patientId: patient.body.patientId,
      resultType: 'PAPANICOLAOU',
      sampleDate: result.sampleDate,
    });
    if (res.status !== 201) throw new Error(`Resultado ${result.folio}: ${res.status}`);
    const id = res.body.resultId!;
    const pdf = syntheticPdf([result.folio, result.sampleDate]);
    const spec = {
      sha256: createHash('sha256').update(pdf).digest('base64'),
      sizeBytes: pdf.byteLength,
    };
    const up = await call('POST', `/v1/admin/results/${id}/upload-url`, {
      contentType: 'application/pdf',
      ...spec,
    });
    const put = await doFetch(up.body.url!, {
      method: 'PUT',
      headers: up.body.headers!,
      body: pdf,
    });
    if (put.status !== 200) throw new Error(`Carga ${result.folio}: ${put.status}`);
    const submit = await call('POST', `/v1/admin/results/${id}/submit`, spec);
    if (submit.status !== 200)
      throw new Error(`Envío a revisión ${result.folio}: ${submit.status}`);
    if (result.approved) {
      const review = await call('POST', `/v1/admin/results/${id}/review`, {
        decision: 'APPROVE',
        checks: { correspondence: true, integrity: true, legibility: true },
      });
      if (review.status !== 200) throw new Error(`Aprobación ${result.folio}: ${review.status}`);
    }
    created++;
    log(`${result.folio} ${result.sampleDate}: ${result.approved ? 'aprobado' : 'en revisión'}`);
  }
  return { created };
}

/** La URL de la API debe corresponder al entorno declarado: evita sembrar en prod por error. */
function assertApiMatchesStage(apiUrl: string, stage: SeedOptions['stage']) {
  const url = new URL(apiUrl);
  if (stage === 'local') {
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('En local la API debe estar en 127.0.0.1 o localhost');
    return;
  }
  if (url.protocol !== 'https:' || url.pathname.replace(/\/$/, '').split('/').at(-1) !== stage)
    throw new Error(`La URL de la API no corresponde al entorno ${stage}`);
}
