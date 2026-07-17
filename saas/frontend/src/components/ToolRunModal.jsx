import { lazy, Suspense, useEffect, useState } from 'react';
import { toolById } from '@shared/catalog.mjs';
import Modal from './Modal.jsx';

// The run popup now hosts the WHOLE run experience — config, the (metered,
// streaming, job-polling) run, and the results — inside a wide modal, so users
// never leave the dashboard. It does that by mounting the real <ToolRunner> in
// `embedded` mode rather than forking its engine (the run path carries credit
// metering, the >30s Function-URL route, streaming and attachments — none of it
// duplicated here). ToolRunner is lazy-loaded so it stays out of the main bundle.
//
// Driven by a `dm:open-tool` window event so one instance serves every card —
// the same idiom the app already uses for `dm:open-chat`.
const ToolRunner = lazy(() => import('../pages/ToolRunner.jsx'));

export default function ToolRunModal() {
  const [toolId, setToolId] = useState(null);

  useEffect(() => {
    const onOpen = (e) => { const id = e.detail?.id; if (id && toolById(id)) setToolId(id); };
    window.addEventListener('dm:open-tool', onOpen);
    return () => window.removeEventListener('dm:open-tool', onOpen);
  }, []);

  const close = () => setToolId(null);
  const tool = toolId ? toolById(toolId) : null;

  return (
    <Modal open={!!tool} onClose={close} wide tag="RUN" title={tool?.name || ''} labelledBy="dm-run-title">
      {tool && (
        <Suspense fallback={<div className="py-16 text-center text-sm text-faint">Loading…</div>}>
          {/* The tool key remounts a fresh runner when you switch tools without closing. */}
          <ToolRunner key={toolId} embedded toolId={toolId} onClose={close} />
        </Suspense>
      )}
    </Modal>
  );
}
