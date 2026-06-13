import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

// Route-level code-splitting — keeps the initial bundle small; heavier pages
// (tool runner, reports, admin) load on demand.
const ToolRunner = lazy(() => import('./pages/ToolRunner.jsx'));
const Pricing = lazy(() => import('./pages/Pricing.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const Usage = lazy(() => import('./pages/Usage.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const History = lazy(() => import('./pages/History.jsx'));
const Support = lazy(() => import('./pages/Support.jsx'));
const Integrations = lazy(() => import('./pages/Integrations.jsx'));
const Projects = lazy(() => import('./pages/Projects.jsx'));
const Tracking = lazy(() => import('./pages/Tracking.jsx'));

const Loading = () => <div className="grid min-h-[40vh] place-items-center text-slate-400">Loading…</div>;

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="grid min-h-screen place-items-center text-slate-400">Loading…</div>;

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tool/:toolId" element={<ToolRunner />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/tracking" element={<Tracking />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/account" element={<Account />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/history" element={<History />} />
          <Route path="/support" element={<Support />} />
          <Route path="/support/:ticketId" element={<Support />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
