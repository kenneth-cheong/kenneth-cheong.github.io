import { Link } from 'react-router-dom';

// Shown for unknown in-app routes instead of a silent redirect to the dashboard.
export default function NotFound() {
  return (
    <div className="grid min-h-[50vh] place-items-center text-center">
      <div>
        <p className="text-5xl font-bold text-slate-200">404</p>
        <h1 className="mt-3 text-xl font-bold text-slate-800">Page not found</h1>
        <p className="mt-2 text-sm text-slate-500">That page doesn’t exist or has moved.</p>
        <Link to="/" className="btn-primary mt-5 inline-block">Back to tools</Link>
      </div>
    </div>
  );
}
