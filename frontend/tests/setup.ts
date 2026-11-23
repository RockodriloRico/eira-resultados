import '@testing-library/jest-dom/vitest';
import { LOCAL_FRONTEND_CONFIG } from '@eira/shared';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { setRuntimeConfig } from '../src/config/runtime.ts';

beforeEach(() => {
  setRuntimeConfig(LOCAL_FRONTEND_CONFIG);
});

afterEach(() => {
  cleanup();
});
