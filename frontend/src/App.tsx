import { SECURITY_POLICY } from '@eira/shared';
import styles from './App.module.css';

export function App() {
  return (
    <main className={styles.container}>
      <h1 className={styles.title}>EIRA Resultados</h1>
      <p className={styles.subtitle}>
        Entrega digital segura de resultados — EIRA Movimiento Rosa A.C.
      </p>
      <p className={styles.notice} role="status">
        Proyecto en construcción. El acceso a resultados estará disponible próximamente.
      </p>
      <p className={styles.meta}>
        Cada código de verificación tendrá una vigencia de {SECURITY_POLICY.pinTtlSeconds / 60}{' '}
        minutos.
      </p>
    </main>
  );
}
