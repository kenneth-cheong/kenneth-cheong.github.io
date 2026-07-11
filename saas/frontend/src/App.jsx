import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Unsubscribe from './pages/Unsubscribe.jsx';
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
const Profile = lazyWithReload(() => import('./pages/Profile.jsx'));
const Usage = lazyWithReload(() => import('./pages/Usage.jsx'));
const Admin = lazyWithReload(() => import('./pages/Admin.jsx'));
const Support = lazyWithReload(() => import('./pages/Support.jsx'));
const Integrations = lazyWithReload(() => import('./pages/Integrations.jsx'));
const Projects = lazyWithReload(() => import('./pages/Projects.jsx'));
const ProjectDetail = lazyWithReload(() => import('./pages/ProjectDetail.jsx'));
const Tracking = lazyWithReload(() => import('./pages/Tracking.jsx'));
const Performance = lazyWithReload(() => import('./pages/Performance.jsx'));
const SiteAudit = lazyWithReload(() => import('./pages/SiteAudit.jsx'));
const SocialAudit = lazyWithReload(() => import('./pages/SocialAudit.jsx'));
const Schedules = lazyWithReload(() => import('./pages/Schedules.jsx'));

const Loading = () => <div className="grid min-h-[40vh] place-items-center text-faint">Loading…</div>;

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div role="status" aria-label="Loading Digimetrics" className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white dark:from-canvas dark:to-surface">
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
        {/* Email-link landings — must work pre-auth; they auto-log-in on success. */}
        <Route path="/verify" element={<VerifyEmail />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/unsubscribe" element={<Unsubscribe />} />
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
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/tracking" element={<Tracking />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/audit" element={<SiteAudit />} />
          <Route path="/social-audit" element={<SocialAudit />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/account" element={<Account />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/usage" element={<Usage />} />
          {/* Legacy path — Runs now lives on the merged Projects page. */}
          <Route path="/history" element={<Projects />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/support" element={<Support />} />
          <Route path="/support/:ticketId" element={<Support />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/legal/terms" element={<Terms />} />
          <Route path="/legal/privacy" element={<Privacy />} />
          {/* Also reachable when signed in (the email link may open in a logged-in tab). */}
          <Route path="/unsubscribe" element={<Unsubscribe />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
