import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { _registerDialogHandler } from '../lib/ui.js';

// Single host for the app's in-app confirm/prompt dialogs. Mounted once (in
// Layout, beside the Toaster) and wired to the imperative confirmDialog/
// promptDialog helpers in lib/ui.js, so any component can `await` a dialog
// without threading a hook through the tree. Renders our shared <Modal>.
export default function DialogHost() {
  const [data, setData] = useState(null); // { kind, message, title, confirmText, cancelText, danger, label, placeholder }
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const resolveRef = useRef(null);

  useEffect(() => {
    _registerDialogHandler((opts) => new Promise((resolve) => {
      resolveRef.current = resolve;
      setData(opts);
      setValue(opts.defaultValue ?? '');
      setOpen(true);
    }));
    return () => _registerDialogHandler(null);
  }, []);

  // Cancelling a confirm resolves false; cancelling a prompt resolves null.
  const cancelValue = data?.kind === 'prompt' ? null : false;
  const settle = (result) => {
    const r = resolveRef.current; resolveRef.current = null;
    setOpen(false);
    r?.(result);
  };
  const accept = () => settle(data?.kind === 'prompt' ? value : true);

  const isPrompt = data?.kind === 'prompt';
  const confirmLabel = data?.confirmText || (isPrompt ? 'OK' : 'Confirm');

  return (
    <Modal
      open={open}
      onClose={() => settle(cancelValue)}
      labelledBy="dm-dialog-title"
      title={data?.title || (isPrompt ? 'Enter a value' : 'Please confirm')}
      footer={(
        <>
          <button
            type="button"
            onClick={() => settle(cancelValue)}
            className="ml-auto rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-dim hover:bg-raised"
          >{data?.cancelText || 'Cancel'}</button>
          <button
            type="button"
            data-autofocus={isPrompt ? undefined : true}
            onClick={accept}
            className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-white ${data?.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700'}`}
          >{confirmLabel}</button>
        </>
      )}
    >
      {data?.message && <p className="whitespace-pre-line text-sm text-body">{data.message}</p>}
      {isPrompt && (
        <div className="mt-3">
          {data.label && <label className="mb-1 block text-xs font-medium text-muted">{data.label}</label>}
          <input
            data-autofocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={data.placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); accept(); } }}
            className="w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
        </div>
      )}
    </Modal>
  );
}
