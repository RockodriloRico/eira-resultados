import { useEffect, useState } from 'react';
import { AdminPortal } from './admin/AdminPortal.tsx';
import { PatientPortal } from './patient/PatientPortal.tsx';
import styles from './App.module.css';

const current = () => (window.location.hash === '#/admin' ? 'admin' : 'patient');

export function App() {
  const [view, setView] = useState(current);
  useEffect(() => {
    const onHash = () => setView(current());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return (
    <main className={styles.container}>
      <h1 className={styles.title}>EIRA Resultados</h1>
      <p className={styles.subtitle}>
        Entrega digital segura de resultados — EIRA Movimiento Rosa A.C.
      </p>
      <nav className={styles.nav} aria-label="Secciones">
        <a href="#/" aria-current={view === 'patient' ? 'page' : undefined}>
          Pacientes
        </a>
        <a href="#/admin" aria-current={view === 'admin' ? 'page' : undefined}>
          Administración
        </a>
      </nav>
      {view === 'admin' ? <AdminPortal /> : <PatientPortal />}
    </main>
  );
}
