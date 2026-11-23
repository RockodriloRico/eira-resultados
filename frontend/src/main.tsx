import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { loadRuntimeConfig } from './config/runtime.ts';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('No se encontró el elemento raíz');
}

loadRuntimeConfig().then(
  () =>
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  () => {
    root.textContent = 'El servicio no está disponible en este momento. Intenta más tarde.';
  },
);
