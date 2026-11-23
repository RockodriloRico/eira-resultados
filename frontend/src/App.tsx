import { useEffect, useState } from 'react';
import { AdminAccess, AdminCallback } from './admin/AdminAccess.tsx';
import { isAdminCallback } from './admin/auth.ts';
import { PatientPortal } from './patient/PatientPortal.tsx';
import styles from './App.module.css';

// `/admin` es el retorno del cierre de sesión de Cognito; `#/admin` la navegación interna.
const current = () => {
  const { hash, pathname } = window.location;
  return hash === '#/admin' || (!hash && pathname === '/admin') ? 'admin' : 'patient';
};

export function App() {
  const [view, setView] = useState(current);
  useEffect(() => {
    const onHash = () => setView(current());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (isAdminCallback()) return <AdminCallback />;
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
      {view === 'admin' ? <AdminAccess /> : <PatientPortal />}
    </main>
  );
}
