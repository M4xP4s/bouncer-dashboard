import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createTheme,
  type CSSVariablesResolver,
  MantineProvider,
} from '@mantine/core';
// Mantine's components are unstyled without its stylesheet.
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/notifications/styles.css';
import './main.css';
import { Notifications } from '@mantine/notifications';
import App from './App.tsx';

// Filled buttons and badges take black or white text, whichever contrasts
// more: at luminance 0.179 the two are equal, so either exceeds 4.5:1.
const theme = createTheme({
  autoContrast: true,
  luminanceThreshold: 0.179,
  // Section headings stay small, so the numbers lead the eye.
  headings: {
    sizes: {
      h1: { fontSize: '1.375rem' },
      h3: { fontSize: '0.9375rem' },
    },
  },
});

// Mantine's dimmed gray, used for field hints and chart axes, is 3.3:1 on
// white; this gray is 8.2:1.
const cssVariables: CSSVariablesResolver = () => ({
  variables: {},
  light: { '--mantine-color-dimmed': 'var(--mantine-color-gray-7)' },
  dark: {},
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssVariables}>
      <Notifications limit={3} />
      <App />
    </MantineProvider>
  </StrictMode>,
);
