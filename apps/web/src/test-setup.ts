import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest globals are off, so Testing Library cannot register this itself.
afterEach(cleanup);

// jsdom does not implement matchMedia. Mantine calls it to read the colour
// scheme, so every component test needs this stand-in.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList;

// jsdom does not lay out elements; Mantine still observes their dimensions.
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
