import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { Terms, Privacy } from './pages/Legal.jsx';
import NotFound from './pages/NotFound.jsx';

// Route-level code-splitting — keeps the initial bundle small; heavier pages
// (tool runner, reports, admin) load on demand.
//
// After a redeploy, hashed chunk filenames change. A user holding a stale
// index.html requests an old chunk that no longer exists → the dynamic import
// rejects ("Failed to fetch dynamically imported module") and the route renders
// blank. lazyWithReload catches that and force-reloads ONCE to pull the fresh
// index.html + chunk names (guarded against a reload loop via sessionStorage).
function lazyWithReload(factory) {
  const KEY = 'dm_chunk_reloaded';
  return lazy(() =>
    factory()
      .then((m) => { sessionStorage.removeItem(KEY); return m; })
      .catch((err) => {
        if (!sessionStorage.getItem(KEY)) {
          sessionStorage.setItem(KEY, '1');
          window.location.reload();
          return new Promise(() => {}); // never resolves — the page is reloading
        }
        throw err; // already reloaded once; surface the real error
      })
  );
}

const ToolRunner = lazyWithReload(() => import('./pages/ToolRunner.jsx'));
const Pricing = lazyWithReload(() => import('./pages/Pricing.jsx'));
const Account = lazyWithReload(() => import('./pages/Account.jsx'));
const Usage = lazyWithReload(() => import('./pages/Usage.jsx'));
const Admin = lazyWithReload(() => import('./pages/Admin.jsx'));
const History = lazyWithReload(() => import('./pages/History.jsx'));
const Support = lazyWithReload(() => import('./pages/Support.jsx'));
const Integrations = lazyWithReload(() => import('./pages/Integrations.jsx'));
const Projects = lazyWithReload(() => import('./pages/Projects.jsx'));
const Tracking = lazyWithReload(() => import('./pages/Tracking.jsx'));

const Loading = () => <div className="grid min-h-[40vh] place-items-center text-slate-400">Loading…</div>;

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white">
        <div className="flex flex-col items-center gap-4">
          <div className="grid h-12 w-12 animate-pulse place-items-center rounded-2xl bg-brand-600 text-2xl font-bold text-white shadow-sm">D</div>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400" />
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        {/* Legal pages are public — reachable before sign-in. */}
        <Route path="/legal/terms" element={<Terms />} />
        <Route path="/legal/privacy" element={<Privacy />} />
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
          <Route path="/legal/terms" element={<Terms />} />
          <Route path="/legal/privacy" element={<Privacy />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
