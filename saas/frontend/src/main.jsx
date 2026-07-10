import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ProjectProvider } from './context/ProjectContext.jsx';
import { SupportTicketsProvider } from './context/SupportTicketsContext.jsx';
import { PlanProvider } from './context/PlanContext.jsx';
import { init as initDiagnostics } from './lib/diagnostics.js';
import { initAnalytics } from './lib/analytics.js';
import './index.css';

// Start capturing diagnostics (errors, failed calls, error toasts) before the
// app mounts so the Report-a-Fault reporter has context from the very first frame.
initDiagnostics();

// Load session recording for UX testing. No-op unless VITE_CLARITY_ID is set,
// so recording stays OFF in a normal build.
initAnalytics();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <ProjectProvider>
            <SupportTicketsProvider>
              <PlanProvider>
                <App />
              </PlanProvider>
            </SupportTicketsProvider>
          </ProjectProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
