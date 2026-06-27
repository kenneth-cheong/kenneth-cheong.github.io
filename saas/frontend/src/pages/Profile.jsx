import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Sparkles } from 'lucide-react';
import {
  PROFILE_FIELDS, PROFILE_GROUPS, PROFILE_BONUS,
  isProfileComplete, profileProgress, profileValueFilled,
} from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { toast } from '../lib/ui.js';
import ProfileField from '../components/ProfileField.jsx';

// Fields grouped by section, preserving PROFILE_GROUPS order.
const SECTIONS = Object.keys(PROFILE_GROUPS).map((group) => ({
  group,
  label: PROFILE_GROUPS[group],
  fields: PROFILE_FIELDS.filter((f) => f.group === group),
}));

export default function Profile() {
  const { user, saveProfile } = useAuth();
  const saved = user.profile || {};
  const [draft, setDraft] = useState(() => {
    const d = {};
    for (const f of PROFILE_FIELDS) d[f.key] = saved[f.key] ?? (f.type === 'multiselect' ? [] : '');
    return d;
  });
  const [busy, setBusy] = useState(false);

  const { done, total } = useMemo(() => profileProgress(draft), [draft]);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const complete = isProfileComplete(draft);
  const alreadyRewarded = !!user.profileBonusGranted;
  // Show the carrot only while it's still claimable (profile not yet complete on
  // the server AND the bonus hasn't been paid).
  const showReward = !alreadyRewarded;

  const setField = (key, val) => setDraft((d) => ({ ...d, [key]: val }));

  // Only send keys that actually changed vs the server copy.
  function changedPatch() {
    const patch = {};
    for (const f of PROFILE_FIELDS) {
      const a = draft[f.key];
      const b = saved[f.key] ?? (f.type === 'multiselect' ? [] : '');
      const eq = Array.isArray(a) && Array.isArray(b)
        ? a.length === b.length && a.every((x, i) => x === b[i])
        : a === b;
      if (!eq) patch[f.key] = a;
    }
    return patch;
  }

  async function onSave() {
    const patch = changedPatch();
    if (!Object.keys(patch).length) { toast('No changes to save.', 'info'); return; }
    setBusy(true);
    try {
      const res = await saveProfile(patch);
      if (res?.bonusGranted) {
        toast(`Profile complete — ${res.bonusAmount || PROFILE_BONUS} tokens added 🎉`, 'success');
      } else {
        toast('Profile saved.', 'success');
      }
    } catch (e) {
      toast(e.message || 'Could not save your profile.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">Your profile</h1>
      <p className="mt-1 text-sm text-slate-500">
        Tell us a bit about you and your business so we can tailor recommendations.
      </p>

      {/* Progress + reward banner */}
      <div className="card mt-6 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="font-semibold">
              {complete ? 'Profile complete' : `${done} of ${total} answered`}
            </p>
            {showReward && !complete && (
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-brand-700">
                <Sparkles size={15} aria-hidden /> Complete everything to earn {PROFILE_BONUS} tokens.
              </p>
            )}
            {(complete || alreadyRewarded) && (
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-green-700">
                <CheckCircle2 size={15} aria-hidden />
                {alreadyRewarded ? `Thanks! Your ${PROFILE_BONUS}-token bonus has been credited.` : 'All set — save to claim your bonus.'}
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <span className="text-2xl font-bold tabular-nums">{pct}%</span>
          </div>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Field sections */}
      {SECTIONS.map((section) => (
        <div key={section.group} className="card mt-4 p-5">
          <h2 className="font-bold">{section.label}</h2>
          <div className="mt-4 space-y-4">
            {section.fields.map((f) => (
              <div key={f.key}>
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700">
                  {f.label}
                  {!f.required && <span className="text-xs font-normal text-slate-400">(optional)</span>}
                  {f.required && profileValueFilled(draft[f.key]) && (
                    <CheckCircle2 size={13} className="text-green-500" aria-hidden />
                  )}
                </label>
                <ProfileField field={f} value={draft[f.key]} onChange={(val) => setField(f.key, val)} />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="sticky bottom-4 mt-6 flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm backdrop-blur">
        <Link to="/" className="text-sm font-medium text-slate-500 hover:text-slate-700">Back to dashboard</Link>
        <button onClick={onSave} disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}
