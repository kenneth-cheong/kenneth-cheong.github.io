import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { getPreference, cyclePreference, subscribe } from '../lib/theme.js';

// Single-button theme switcher cycling light → dark → system. The icon shows
// the current preference; the tooltip names what a click switches to next.
const NEXT = { light: 'dark', dark: 'system', system: 'light' };
const LABEL = { light: 'Light', dark: 'Dark', system: 'System' };

export default function ThemeToggle({ className = '', tourId }) {
  const [pref, setPref] = useState(getPreference);
  useEffect(() => subscribe(setPref), []);

  const Icon = pref === 'dark' ? Moon : pref === 'system' ? Monitor : Sun;
  return (
    <button
      onClick={() => setPref(cyclePreference())}
      data-tour={tourId}
      title={`Theme: ${LABEL[pref]} — switch to ${LABEL[NEXT[pref]]}`}
      aria-label={`Theme: ${LABEL[pref]}. Switch to ${LABEL[NEXT[pref]]}.`}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sunken text-dim hover:bg-overlay ${className}`}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}
