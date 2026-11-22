import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';

describe('App', () => {
  it('muestra el nombre del proyecto y el portal de pacientes por omisión', () => {
    window.location.hash = '';
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'EIRA Resultados' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Consulta de resultados' })).toBeInTheDocument();
  });

  it('#/admin abre la administración con el aviso de identidad sintética local', () => {
    window.location.hash = '#/admin';
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Administración' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('solo en el servidor local');
    window.location.hash = '';
  });
});
