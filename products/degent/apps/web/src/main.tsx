import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readConfig } from './config';
import { createServices } from './services';
import './styles.css';

const app = readConfig(import.meta.env as Record<string, string | undefined>, window.location.search);
const services = createServices(app);
document.documentElement.dataset.mode = services.mode;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App app={app} services={services} />
  </StrictMode>,
);
