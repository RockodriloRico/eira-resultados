import type { CognitoAdminConfig } from '@eira/shared';
import type { User, UserManager } from 'oidc-client-ts';
import { useEffect, useMemo, useState } from 'react';
import { runtimeConfig } from '../config/runtime.ts';
import styles from '../ui.module.css';
import { AdminPortal } from './AdminPortal.tsx';
import { adminSignOut, adminUserManager } from './auth.ts';

/** Elige la autenticación administrativa según config.json: Cognito en AWS, sintética en local. */
export function AdminAccess({ manager }: { manager?: UserManager | undefined } = {}) {
  const config = runtimeConfig();
  if (config.admin.mode === 'local')
    return (
      <>
        <p className={styles.demo} role="note">
          Identidad administrativa sintética: solo en el servidor local (127.0.0.1). En AWS el
          acceso es con Cognito.
        </p>
        <AdminPortal />
      </>
    );
  return <CognitoAdmin config={config.admin} manager={manager} />;
}

function CognitoAdmin({
  config,
  manager,
}: {
  config: CognitoAdminConfig;
  manager?: UserManager | undefined;
}) {
  const users = useMemo(() => manager ?? adminUserManager(config), [manager, config]);
  const [user, setUser] = useState<User>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const loaded = (u: User) => setUser(u);
    const ended = () => setUser(undefined);
    users.events.addUserLoaded(loaded);
    users.events.addUserUnloaded(ended);
    users.events.addAccessTokenExpired(ended);
    users.events.addSilentRenewError(ended);
    return () => {
      users.events.removeUserLoaded(loaded);
      users.events.removeUserUnloaded(ended);
      users.events.removeAccessTokenExpired(ended);
      users.events.removeSilentRenewError(ended);
    };
  }, [users]);

  const signIn = () => {
    setError(undefined);
    // Sin await previo: la ventana emergente debe abrirse dentro del clic.
    users
      .signinPopup()
      .then(setUser, () =>
        setError('No se pudo iniciar sesión. Permite la ventana emergente e intenta de nuevo.'),
      );
  };
  const expired = () => {
    void users.removeUser();
    setError('Tu sesión terminó. Inicia sesión de nuevo.');
  };

  if (!user || user.expired)
    return (
      <section className={styles.panel} aria-labelledby="admin-login">
        <h2 id="admin-login">Administración</h2>
        <p>Acceso exclusivo para personal autorizado de EIRA, con MFA.</p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <button type="button" onClick={signIn}>
          Iniciar sesión
        </button>
      </section>
    );
  return (
    <>
      <p className={styles.row}>
        <button type="button" onClick={() => void adminSignOut(users, config)}>
          Cerrar sesión
        </button>
      </p>
      <AdminPortal token={user.access_token} onUnauthorized={expired} />
    </>
  );
}

/** Página /admin/callback dentro de la ventana emergente: entrega la respuesta a la ventana principal. */
export function AdminCallback() {
  const admin = runtimeConfig().admin;
  const [failed, setFailed] = useState(admin.mode !== 'cognito');
  useEffect(() => {
    if (admin.mode !== 'cognito') return;
    adminUserManager(admin)
      .signinPopupCallback()
      .catch(() => setFailed(true));
  }, [admin]);
  return (
    <p role="status">
      {failed ? 'No se pudo completar el inicio de sesión.' : 'Iniciando sesión…'}
    </p>
  );
}
