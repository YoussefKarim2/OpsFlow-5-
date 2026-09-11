import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element in index.html');

createRoot(root).render(
  <StrictMode>
    {/*
      The outer net. The per-screen boundary inside App handles anything that
      fails while rendering a page; this one catches the rarer case of the
      providers themselves failing, where there is no shell left to fall back
      to — and turns a white page into an explanation.
    */}
    <ErrorBoundary label="OpsFlow">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
