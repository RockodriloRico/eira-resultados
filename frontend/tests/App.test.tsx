import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';

describe('App', () => {
  it('muestra el nombre del proyecto', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'EIRA Resultados' })).toBeInTheDocument();
  });

  it('usa la vigencia del PIN definida en @eira/shared', () => {
    render(<App />);
    expect(screen.getByText(/vigencia de 5\s+minutos/)).toBeInTheDocument();
  });
});
