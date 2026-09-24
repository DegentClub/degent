import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Site } from './site/Site';
import { readConfig } from './config';
import { createServices } from './services';
import { createSiteServices } from './site/services';
import './styles.css';
import './site/site.css';

const app = readConfig(import.meta.env as Record<string, string | undefined>, window.location.search);
const mint = createServices(app);
const site = createSiteServices(app);
document.documentElement.dataset.mode = mint.mode;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Site app={app} site={site} mint={mint} />
  </StrictMode>,
);
