import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Logo from './components/Logo.jsx';
import Login from './pages/Login.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Unsubscribe from './pages/Unsubscribe.jsx';
import Dashboard from './pages/Dashboard.jsx';
import NotFound from './pages/NotFound.jsx';
// Not lazy: it is the whole app for a locked account, so a chunk fetch would be
// one more thing to fail in front of someone already seeing something go wrong.
import Locked from './pages/Locked.jsx';

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

// The legal instrument is ~120KB of generated text (36 T&C sections + 20 privacy
// sections). Almost nobody opens it, so it must not sit in the initial bundle.
const Terms = lazyWithReload(() => import('./pages/Legal.jsx').then((m) => ({ default: m.Terms })));
const Privacy = lazyWithReload(() => import('./pages/Legal.jsx').then((m) => ({ default: m.Privacy })));
const ToolRunner = lazyWithReload(() => import('./pages/ToolRunner.jsx'));
const Pricing = lazyWithReload(() => import('./pages/Pricing.jsx'));
const Account = lazyWithReload(() => import('./pages/Account.jsx'));
const Profile = lazyWithReload(() => import('./pages/Profile.jsx'));
const Usage = lazyWithReload(() => import('./pages/Usage.jsx'));
const CreditGuide = lazyWithReload(() => import('./pages/CreditGuide.jsx'));
const Admin = lazyWithReload(() => import('./pages/Admin.jsx'));
const Support = lazyWithReload(() => import('./pages/Support.jsx'));
const Integrations = lazyWithReload(() => import('./pages/Integrations.jsx'));
const Projects = lazyWithReload(() => import('./pages/Projects.jsx'));
const ProjectDetail = lazyWithReload(() => import('./pages/ProjectDetail.jsx'));
const Tracking = lazyWithReload(() => import('./pages/Tracking.jsx'));
const Performance = lazyWithReload(() => import('./pages/Performance.jsx'));
const SiteAudit = lazyWithReload(() => import('./pages/SiteAudit.jsx'));
const SocialAudit = lazyWithReload(() => import('./pages/SocialAudit.jsx'));
const PerformanceAudit = lazyWithReload(() => import('./pages/PerformanceAudit.jsx'));
const SeoDiagnostics = lazyWithReload(() => import('./pages/SeoDiagnostics.jsx'));
const Schedules = lazyWithReload(() => import('./pages/Schedules.jsx'));
const Tools = lazyWithReload(() => import('./pages/Tools.jsx'));
const Notifications = lazyWithReload(() => import('./pages/Notifications.jsx'));
const OpenRun = lazyWithReload(() => import('./pages/OpenRun.jsx'));

const Loading = () => <div className="grid min-h-[40vh] place-items-center text-faint">Loading…</div>;

// The tools LIST is /tools but a single tool is /tool/:toolId, and the plural is
// the natural guess — every hand-typed or externally-shared "/tools/technical-seo"
// used to land on the 404 page. Redirect to the real route instead (replace: the
// wrong URL shouldn't sit in history and come back on Back). An unknown toolId
// still ends up on ToolRunner, which has its own handling for that.
function ToolPathRedirect() {
  const { toolId } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`/tool/${toolId}${search}${hash}`} replace />;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div role="status" aria-label="Loading Digimetrics" className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white dark:from-canvas dark:to-surface">
        <div className="flex flex-col items-center gap-4">
          <Logo className="animate-pulse" width={180} />
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
    // Suspense is required here, not optional: the legal pages below are lazy
    // (they carry the ~120KB instrument), and a lazy route with no boundary
    // above it throws instead of rendering.
    return (
      <Suspense fallback={<Loading />}>
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
      </Suspense>
    );
  }

  // Trial expired, or a subscription payment that never landed past its grace
  // window. The backend refuses the app's routes outright (403 access_locked),
  // so rendering the normal shell would just paint a dashboard of failed
  // requests. Instead: the explanation screen, plus the handful of pages that
  // exist precisely to resolve it — Pricing and Account (where the card lives),
  // Support, and the legal texts. Nothing here deletes anything; the moment
  // /me reports an unlocked account the full app returns on its own.
  if (user.access?.locked) {
    return (
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/pricing" element={<Layout><Pricing /></Layout>} />
          <Route path="/account" element={<Layout><Account /></Layout>} />
          <Route path="/support" element={<Layout><Support /></Layout>} />
          <Route path="/support/:ticketId" element={<Layout><Support /></Layout>} />
          <Route path="/legal/terms" element={<Terms />} />
          <Route path="/legal/privacy" element={<Privacy />} />
          <Route path="/unsubscribe" element={<Unsubscribe />} />
          <Route path="*" element={<Locked />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Layout>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/tools/:toolId" element={<ToolPathRedirect />} />
          <Route path="/tool/:toolId" element={<ToolRunner />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/tracking" element={<Tracking />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/audit" element={<SiteAudit />} />
          <Route path="/social-audit" element={<SocialAudit />} />
          <Route path="/performance-audit" element={<PerformanceAudit />} />
          <Route path="/seo-diagnostics" element={<SeoDiagnostics />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/account" element={<Account />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/credit-guide" element={<CreditGuide />} />
          {/* Legacy path — Runs now lives on the merged Projects page. */}
          <Route path="/history" element={<Projects />} />
          {/* Deep link to one saved result — what "X finished" notifications
              point at. Resolves the run, then hands off to the tool view. */}
          <Route path="/runs/:runId" element={<OpenRun />} />
          <Route path="/notifications" element={<Notifications />} />
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
