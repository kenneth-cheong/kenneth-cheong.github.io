import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Play } from 'lucide-react';
import { toolById, inputsFor, CREDIT_COSTS } from '@shared/catalog.mjs';
import Modal from './Modal.jsx';

// The approved design's run popup (mockup #modal-tool in its "NEW RUN" state):
// a tool card opens a sheet with the run's config, its cost, and a Run button —
// rather than dropping you straight onto a full page.
//
// The fields and the cost are the REAL ones (inputsFor / CREDIT_COSTS), and Run
// hands the collected values to ToolRunner via router state, which it already
// seeds from (`location.state.values`). Deliberately NOT executing in here: the
// real run path carries credit metering, the >30s Function-URL route, streaming
// and attachments, and a second half-built copy of that would spend real credits
// down a path nobody tests.
//
// Driven by a `dm:open-tool` window event so one instance serves every card —
// the same idiom the app already uses for `dm:open-chat`.
export default function ToolRunModal() {
  const [toolId, setToolId] = useState(null);
  const [values, setValues] = useState({});
  const navigate = useNavigate();

  useEffect(() => {
    const onOpen = (e) => {
      const id = e.detail?.id;
      if (!id) return;
      const t = toolById(id);
      if (!t) return;
      setValues(Object.fromEntries(inputsFor(t).map((f) => [f.name, f.default ?? ''])));
      setToolId(id);
    };
    window.addEventListener('dm:open-tool', onOpen);
    return () => window.removeEventListener('dm:open-tool', onOpen);
  }, []);

  const tool = toolId ? toolById(toolId) : null;
  const fields = useMemo(() => (tool ? inputsFor(tool) : []), [tool]);
  const cost = tool ? CREDIT_COSTS[tool.cost] ?? 0 : 0;

  const close = () => setToolId(null);
  const run = () => {
    navigate(`/tool/${toolId}`, { state: { values } });
    close();
  };

  return (
    <Modal
      open={!!tool}
      onClose={close}
      tag="NEW RUN"
      title={tool?.name || ''}
      labelledBy="dm-run-title"
      footer={
        <button type="button" onClick={run} className="btn-primary px-5 py-3 text-sm" data-autofocus>
          <Play size={14} aria-hidden /> Run {tool?.name}
        </button>
      }
    >
      {tool && <p className="text-xs leading-relaxed text-muted">{tool.desc}</p>}

      {/* Fields flow into two columns on the roomier modal; full-width textareas
          span both so long inputs stay legible. */}
      <div className="grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
            <label htmlFor={`run-${f.name}`} className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.08em] text-faint">
              {f.label}{f.required && <span className="ml-1 text-neg">*</span>}
            </label>
            {f.type === 'textarea' ? (
              <textarea
                id={`run-${f.name}`}
                rows={3}
                value={values[f.name] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="field"
              />
            ) : f.type === 'select' ? (
              <select
                id={`run-${f.name}`}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="field dm-select pr-8"
              >
                {(f.options || []).map((o) => {
                  const val = typeof o === 'string' ? o : o.value;
                  const lbl = typeof o === 'string' ? o : o.label ?? o.value;
                  return <option key={val} value={val}>{lbl}</option>;
                })}
              </select>
            ) : (
              <input
                id={`run-${f.name}`}
                type="text"
                value={values[f.name] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="field"
              />
            )}
          </div>
        ))}
      </div>

      {/* The mockup's cost line — real credit price, real duration hint. */}
      <div className="flex items-center gap-2 text-[11.5px] text-muted">
        <Zap size={14} className="text-warn" aria-hidden />
        This run costs <b className="text-heading">{cost === 0 ? 'nothing' : `${cost} credit${cost > 1 ? 's' : ''}`}</b>
        {tool?.slow && <>· about 30–150 seconds</>}
      </div>
    </Modal>
  );
}
