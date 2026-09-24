import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage may be unavailable */
  }
  // The hash router reads window.location: start every test at the root route.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
});

// jsdom's object URLs do not interoperate with the Blob global in this environment: stub them.
let n = 0;
URL.createObjectURL = () => `blob:test/${++n}`;
URL.revokeObjectURL = () => undefined;
