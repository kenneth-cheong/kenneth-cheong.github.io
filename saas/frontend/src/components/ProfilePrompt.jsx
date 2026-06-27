import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import {
  PROFILE_FIELDS, PROFILE_REQUIRED_KEYS, PROFILE_BONUS,
  profileProgress, profileValueFilled,
} from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { toast } from '../lib/ui.js';
import ProfileField from './ProfileField.jsx';

const SNOOZE_KEY = 'dm_profile_snooze';
const SNOOZE_DAYS = 7;

// Progressive-profiling nudge on the Dashboard: shows the next 1–2 unanswered
// required questions inline. Answering advances to the next; completing the whole
// profile pays a one-time PROFILE_BONUS (handled server-side). Non-blocking, so
// "Maybe later" just snoozes via localStorage — the profile data stays durable.
export default function ProfilePrompt() {
  const { user, saveProfile } = useAuth();
  const profile = user.profile || {};
  const [pending, setPending] = useState({}); // edits not yet saved
  const [busy, setBusy] = useState(false);
  const [snoozed, setSnoozed] = useState(() => {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return until > Date.now();
  });

  // Next 1–2 unanswered required fields (in schema order).
  const nextFields = useMemo(() => {
    const order = new Map(PROFILE_FIELDS.map((f, i) => [f.key, i]));
    return PROFILE_REQUIRED_KEYS
      .filter((k) => !profileValueFilled(profile[k]))
      .sort((a, b) => order.get(a) - order.get(b))
      .slice(0, 2)
      .map((k) => PROFILE_FIELDS.find((f) => f.key === k));
  }, [profile]);

  const { done, total } = profileProgress(profile);
  const pct = total ? Math.round((done / total) * 100) : 0;

  // Hide once complete, already rewarded, snoozed, or nothing left to ask.
  if (user.profileBonusGranted || nextFields.length === 0 || snoozed) return null;

  const setField = (key, val) => setPending((p) => ({ ...p, [key]: val }));
  const valueFor = (f) => (f.key in pending ? pending[f.key] : (profile[f.key] ?? (f.type === 'multiselect' ? [] : '')));

  // Only send the shown fields that the user actually filled in.
  function patchToSave() {
    const patch = {};
    for (const f of nextFields) {
      const v = valueFor(f);
      if (profileValueFilled(v)) patch[f.key] = v;
    }
    return patch;
  }

  async function onSave() {
    const patch = patchToSave();
    if (!Object.keys(patch).length) { toast('Answer at least one question first.', 'info'); return; }
    setBusy(true);
    try {
      const res = await saveProfile(patch);
      setPending({});
      if (res?.bonusGranted) toast(`Profile complete — ${res.bonusAmount || PROFILE_BONUS} tokens added 🎉`, 'success');
      else toast('Thanks! Saved.', 'success');
    } catch (e) {
      toast(e.message || 'Could not save.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function snooze() {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86400000));
    setSnoozed(true);
  }

  return (
    <div className="mt-6 rounded-xl border border-brand-200 bg-brand-50/60 p-5">
      <div className="flex items-start justify-between gap-4">
        <h2 className="flex items-center gap-1.5 font-semibold text-brand-800">
          <Sparkles size={16} aria-hidden /> Complete your profile &amp; earn {PROFILE_BONUS} tokens
        </h2>
        <button onClick={snooze} className="shrink-0 text-sm text-slate-400 hover:text-slate-700">Maybe later</button>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/70">
          <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium tabular-nums text-brand-700">{done}/{total}</span>
      </div>

      <div className="mt-4 space-y-3">
        {nextFields.map((f) => (
          <div key={f.key}>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">{f.label}</label>
            <ProfileField field={f} value={valueFor(f)} onChange={(val) => setField(f.key, val)} />
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={onSave} disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : 'Save & continue'}
        </button>
        <Link to="/profile" className="text-sm font-medium text-brand-700 hover:text-brand-800">
          Complete all &amp; get {PROFILE_BONUS} tokens →
        </Link>
      </div>
    </div>
  );
}
