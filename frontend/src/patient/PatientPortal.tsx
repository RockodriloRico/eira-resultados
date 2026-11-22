import { type FormEvent, useEffect, useState } from 'react';
import type {
  ChallengeResponse,
  DownloadUrlResponse,
  PatientResultSummary,
  VerifyResponse,
} from '@eira/shared';
import { ApiError, api, errorMessage } from '../api/client.ts';
import styles from '../ui.module.css';

type Step =
  | { name: 'identify' }
  | { name: 'pin'; challenge: ChallengeResponse; resendAt: number }
  | { name: 'results'; token: string; results: PatientResultSummary[] };

const formValue = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export function PatientPortal() {
  const [step, setStep] = useState<Step>({ name: 'identify' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [link, setLink] = useState<{ resultId: string; url: string }>();

  useEffect(() => {
    if (step.name !== 'pin') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step.name]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && step.name === 'results') {
        setStep({ name: 'identify' });
        setError('Tu sesión terminó. Vuelve a identificarte.');
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const onIdentify = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const challenge = await api<ChallengeResponse>('POST', '/v1/access/request', {
        body: {
          fullName: formValue(form, 'fullName'),
          birthDate: formValue(form, 'birthDate'),
          folio: formValue(form, 'folio'),
        },
      });
      setStep({ name: 'pin', challenge, resendAt: Date.now() + challenge.resendAfter * 1000 });
      setNow(Date.now());
    });
  };

  const onVerify = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (step.name !== 'pin') return;
    const pin = formValue(new FormData(e.currentTarget), 'pin');
    void run(async () => {
      const { token } = await api<VerifyResponse>('POST', '/v1/access/verify', {
        body: { challengeId: step.challenge.challengeId, pin },
      });
      const { results } = await api<{ results: PatientResultSummary[] }>('GET', '/v1/results', {
        token,
      });
      setStep({ name: 'results', token, results });
    });
  };

  const onResend = () => {
    if (step.name !== 'pin') return;
    void run(async () => {
      const challenge = await api<ChallengeResponse>('POST', '/v1/access/resend', {
        body: { challengeId: step.challenge.challengeId },
      });
      setStep({ name: 'pin', challenge, resendAt: Date.now() + challenge.resendAfter * 1000 });
    });
  };

  const onDownload = (resultId: string) => {
    if (step.name !== 'results') return;
    void run(async () => {
      const { url } = await api<DownloadUrlResponse>(
        'POST',
        `/v1/results/${encodeURIComponent(resultId)}/download-url`,
        { token: step.token },
      );
      setLink({ resultId, url });
    });
  };

  const onLogout = () => {
    if (step.name !== 'results') return;
    const { token } = step;
    setLink(undefined);
    setStep({ name: 'identify' });
    void api('POST', '/v1/access/logout', { token }).catch(() => undefined);
  };

  return (
    <section className={styles.panel} aria-labelledby="patient-title">
      <h2 id="patient-title">Consulta de resultados</h2>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {step.name === 'identify' && (
        <form className={styles.form} onSubmit={onIdentify}>
          <p className={styles.muted}>
            Escribe tus datos tal como aparecen en tu expediente. Si coinciden, enviaremos un código
            de 6 dígitos por SMS al teléfono registrado.
          </p>
          <label>
            Nombre completo
            <input name="fullName" required autoComplete="name" minLength={3} maxLength={120} />
          </label>
          <label>
            Fecha de nacimiento
            <input name="birthDate" type="date" required autoComplete="bday" />
          </label>
          <label>
            Folio
            <input name="folio" required pattern="[A-Za-z0-9-]{4,32}" autoComplete="off" />
          </label>
          <button type="submit" disabled={busy}>
            Solicitar código
          </button>
        </form>
      )}

      {step.name === 'pin' && (
        <form className={styles.form} onSubmit={onVerify}>
          <p className={styles.muted}>
            Si los datos coinciden con un expediente, recibirás un código por SMS. Vence en{' '}
            {Math.round(step.challenge.expiresIn / 60)} minutos.
          </p>
          {step.challenge.demoPin && (
            <p className={styles.demo} role="status">
              Modo demostración (sin SMS real): el código es{' '}
              <strong data-testid="demo-pin">{step.challenge.demoPin}</strong>
            </p>
          )}
          <label>
            Código de 6 dígitos
            <input
              name="pin"
              required
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
            />
          </label>
          <div className={styles.row}>
            <button type="submit" disabled={busy}>
              Verificar
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={onResend}
              disabled={busy || now < step.resendAt}
            >
              {now < step.resendAt
                ? `Reenviar en ${Math.ceil((step.resendAt - now) / 1000)} s`
                : 'Reenviar código'}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setError(undefined);
                setStep({ name: 'identify' });
              }}
              disabled={busy}
            >
              Corregir mis datos
            </button>
          </div>
        </form>
      )}

      {step.name === 'results' && (
        <div>
          {step.results.length === 0 ? (
            <p>Aún no hay resultados disponibles.</p>
          ) : (
            <ul className={styles.list}>
              {step.results.map((r) => (
                <li key={r.resultId} className={styles.item}>
                  <span>
                    {r.resultType === 'PAPANICOLAOU' ? 'Papanicolaou' : r.resultType} · muestra del{' '}
                    {r.sampleDate}
                  </span>
                  {link?.resultId === r.resultId ? (
                    <a href={link.url} target="_blank" rel="noopener noreferrer">
                      Abrir PDF (vence en 60 s)
                    </a>
                  ) : (
                    <button type="button" onClick={() => onDownload(r.resultId)} disabled={busy}>
                      Ver PDF
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.muted}>
            Por seguridad, cada enlace dura 60 segundos y la sesión 15 minutos. EIRA entrega el
            documento del laboratorio sin interpretarlo; consulta a tu médico.
          </p>
          <button type="button" className={styles.secondary} onClick={onLogout}>
            Cerrar sesión
          </button>
        </div>
      )}
    </section>
  );
}
