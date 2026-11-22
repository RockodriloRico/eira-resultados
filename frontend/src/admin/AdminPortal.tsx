import { type FormEvent, useState } from 'react';
import type {
  AdminPatientView,
  AdminResultView,
  AuditEventView,
  ReviewUrlResponse,
  UploadUrlResponse,
} from '@eira/shared';
import { SECURITY_POLICY } from '@eira/shared';
import { ApiError, api, errorMessage, sha256Base64 } from '../api/client.ts';
import styles from '../ui.module.css';

const STATUS_LABEL: Record<AdminResultView['status'], string> = {
  CREATED: 'Sin documento',
  PENDING_REVIEW: 'Pendiente de revisión',
  APPROVED: 'Aprobado (visible para la paciente)',
  CORRECTION_REQUESTED: 'Corrección solicitada',
};
const field = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export function AdminPortal() {
  const [patient, setPatient] = useState<AdminPatientView>();
  const [results, setResults] = useState<AdminResultView[]>([]);
  const [audit, setAudit] = useState<AuditEventView[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reviewLink, setReviewLink] = useState<{ resultId: string; url: string }>();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function open(p: AdminPatientView) {
    const list = await api<{ results: AdminResultView[] }>(
      'GET',
      `/v1/admin/patients/${encodeURIComponent(p.patientId)}/results`,
    );
    setPatient(p);
    setResults(list.results);
    setReviewLink(undefined);
    setAudit(undefined);
  }
  const reload = () => (patient ? open(patient) : Promise.resolve());

  const onFind = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const folio = field(new FormData(e.currentTarget), 'folio');
    void run(async () =>
      open(
        await api<AdminPatientView>('GET', `/v1/admin/patients?folio=${encodeURIComponent(folio)}`),
      ),
    );
  };

  const onCreatePatient = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const target = e.currentTarget;
    void run(async () => {
      const created = await api<AdminPatientView>('POST', '/v1/admin/patients', {
        body: {
          fullName: field(form, 'fullName'),
          birthDate: field(form, 'birthDate'),
          folio: field(form, 'folio'),
          phone: field(form, 'phone'),
        },
      });
      target.reset();
      await open(created);
      setNotice('Expediente creado.');
    });
  };

  const onCreateResult = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!patient) return;
    const sampleDate = field(new FormData(e.currentTarget), 'sampleDate');
    void run(async () => {
      await api('POST', '/v1/admin/results', {
        body: { patientId: patient.patientId, resultType: 'PAPANICOLAOU', sampleDate },
      });
      await reload();
    });
  };

  const onUpload = (resultId: string, file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      if (file.type !== 'application/pdf') throw new ApiError(0, 'Solo se aceptan archivos PDF');
      if (file.size > SECURITY_POLICY.maxDocumentBytes)
        throw new ApiError(0, 'El PDF supera 10 MB');
      const bytes = await file.arrayBuffer();
      const spec = { sha256: await sha256Base64(bytes), sizeBytes: bytes.byteLength };
      const target = await api<UploadUrlResponse>(
        'POST',
        `/v1/admin/results/${encodeURIComponent(resultId)}/upload-url`,
        { body: { contentType: 'application/pdf', ...spec } },
      );
      const put = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: bytes,
        credentials: 'omit',
      });
      if (!put.ok) throw new ApiError(0, 'El almacenamiento rechazó el archivo');
      await api('POST', `/v1/admin/results/${encodeURIComponent(resultId)}/submit`, {
        body: spec,
      });
      await reload();
      setNotice('Documento cargado y verificado (SHA-256). Pendiente de revisión.');
    });
  };

  const onViewPdf = (resultId: string) =>
    void run(async () => {
      const { url } = await api<ReviewUrlResponse>(
        'POST',
        `/v1/admin/results/${encodeURIComponent(resultId)}/review-url`,
      );
      setReviewLink({ resultId, url });
    });

  const onReview = (resultId: string, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const form = new FormData(e.currentTarget);
    const note = field(form, 'note');
    void run(async () => {
      await api('POST', `/v1/admin/results/${encodeURIComponent(resultId)}/review`, {
        body: {
          decision: submitter?.value === 'APPROVE' ? 'APPROVE' : 'REQUEST_CORRECTION',
          checks: {
            correspondence: form.get('correspondence') === 'on',
            integrity: form.get('integrity') === 'on',
            legibility: form.get('legibility') === 'on',
          },
          ...(note ? { note } : {}),
        },
      });
      await reload();
    });
  };

  const onAudit = () => {
    if (!patient) return;
    void run(async () => {
      const to = new Date(Date.now() + 60_000).toISOString();
      const from = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const params = new URLSearchParams({ patientId: patient.patientId, from, to });
      const res = await api<{ items: AuditEventView[] }>('GET', `/v1/admin/audit?${params}`);
      setAudit(res.items);
    });
  };

  return (
    <section className={styles.panel} aria-labelledby="admin-title">
      <h2 id="admin-title">Administración</h2>
      <p className={styles.demo} role="note">
        Identidad administrativa sintética: solo en el servidor local (127.0.0.1). En AWS el acceso
        es con Cognito.
      </p>
      <p className={styles.muted}>
        La revisión solo comprueba correspondencia, integridad y legibilidad. EIRA no interpreta ni
        valida clínicamente los resultados.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <div className={styles.columns}>
        <form className={styles.form} onSubmit={onFind} aria-label="Buscar expediente">
          <h3>Buscar expediente</h3>
          <label>
            Folio exacto
            <input name="folio" required pattern="[A-Za-z0-9-]{4,32}" />
          </label>
          <button type="submit" disabled={busy}>
            Buscar
          </button>
        </form>
        <form className={styles.form} onSubmit={onCreatePatient} aria-label="Nuevo expediente">
          <h3>Nuevo expediente</h3>
          <label>
            Nombre completo
            <input name="fullName" required minLength={3} maxLength={120} />
          </label>
          <label>
            Fecha de nacimiento
            <input name="birthDate" type="date" required />
          </label>
          <label>
            Folio
            <input name="folio" required pattern="[A-Za-z0-9-]{4,32}" />
          </label>
          <label>
            Teléfono (E.164)
            <input name="phone" required pattern="\+[1-9]\d{7,14}" placeholder="+5255…" />
          </label>
          <button type="submit" disabled={busy}>
            Crear expediente
          </button>
        </form>
      </div>

      {patient && (
        <div className={styles.block}>
          <h3>Expediente</h3>
          <p>
            <code>{patient.patientId}</code> · {patient.status} · {patient.dataClassification} ·
            teléfono {patient.phoneMasked}
          </p>
          <form className={styles.row} onSubmit={onCreateResult} aria-label="Nuevo resultado">
            <label>
              Fecha de muestra
              <input name="sampleDate" type="date" required />
            </label>
            <button type="submit" disabled={busy}>
              Registrar resultado
            </button>
          </form>

          <ul className={styles.list}>
            {results.map((r) => (
              <li key={r.resultId} className={styles.card} data-testid="admin-result">
                <p>
                  <strong>Papanicolaou</strong> · muestra {r.sampleDate} · versión {r.version} ·{' '}
                  <span>{STATUS_LABEL[r.status]}</span>
                </p>
                {r.reviewNote && <p className={styles.muted}>Nota: {r.reviewNote}</p>}
                {(r.status === 'CREATED' || r.status === 'CORRECTION_REQUESTED') && (
                  <label>
                    Cargar PDF
                    <input
                      type="file"
                      accept="application/pdf"
                      disabled={busy}
                      onChange={(e) => onUpload(r.resultId, e.currentTarget.files?.[0])}
                    />
                  </label>
                )}
                {r.status === 'PENDING_REVIEW' && (
                  <form className={styles.form} onSubmit={(e) => onReview(r.resultId, e)}>
                    {reviewLink?.resultId === r.resultId ? (
                      <a href={reviewLink.url} target="_blank" rel="noopener noreferrer">
                        Abrir PDF para revisión (vence en 60 s)
                      </a>
                    ) : (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => onViewPdf(r.resultId)}
                        disabled={busy}
                      >
                        Ver PDF (60 s)
                      </button>
                    )}
                    <ReviewChecks />
                  </form>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className={styles.secondary} onClick={onAudit} disabled={busy}>
            Ver auditoría (30 días)
          </button>
          {audit && (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Evento</th>
                  <th>Resultado</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.eventId}>
                    <td>{a.occurredAt}</td>
                    <td>{a.eventType}</td>
                    <td>
                      {a.outcome}
                      {a.reasonCode ? ` (${a.reasonCode})` : ''}
                    </td>
                    <td>{a.actorType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

function ReviewChecks() {
  const [checks, setChecks] = useState({
    correspondence: false,
    integrity: false,
    legibility: false,
  });
  const all = checks.correspondence && checks.integrity && checks.legibility;
  const toggle = (key: keyof typeof checks) => () => setChecks((c) => ({ ...c, [key]: !c[key] }));
  return (
    <>
      <fieldset>
        <legend>Verificación administrativa (no clínica)</legend>
        <label>
          <input
            type="checkbox"
            name="correspondence"
            checked={checks.correspondence}
            onChange={toggle('correspondence')}
          />
          El documento corresponde a la paciente y a la muestra
        </label>
        <label>
          <input
            type="checkbox"
            name="integrity"
            checked={checks.integrity}
            onChange={toggle('integrity')}
          />
          El documento está completo
        </label>
        <label>
          <input
            type="checkbox"
            name="legibility"
            checked={checks.legibility}
            onChange={toggle('legibility')}
          />
          El documento es legible
        </label>
      </fieldset>
      <label>
        Nota (obligatoria para solicitar corrección)
        <textarea name="note" maxLength={500} />
      </label>
      <div className={styles.row}>
        <button type="submit" value="APPROVE" disabled={!all}>
          Aprobar
        </button>
        <button type="submit" value="REQUEST_CORRECTION" className={styles.secondary}>
          Solicitar corrección
        </button>
      </div>
    </>
  );
}
