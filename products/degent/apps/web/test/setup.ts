import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* storage may be unavailable */
  }
});

// jsdom's object URLs do not interoperate with the Blob global in this environment: stub them.
let n = 0;
URL.createObjectURL = () => `blob:test/${++n}`;
URL.revokeObjectURL = () => undefined;

// jsdom does not implement scrolling.
window.scrollTo = (() => undefined) as typeof window.scrollTo;
