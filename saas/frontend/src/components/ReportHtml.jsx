import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getPreference, resolveTheme, subscribe } from '../lib/theme.js';
import { themeReport } from '../lib/reportTheme.js';

// Renders server-provided report HTML (dangerouslySetInnerHTML) and normalizes
// its inline light-themed colors for dark mode (see lib/reportTheme.js). The
// transform re-runs whenever the html changes OR the theme flips. useLayoutEffect
// applies it before paint, so there's no flash of the light document.
export default function ReportHtml({ html, className = 'dm-report max-w-none text-sm text-body' }) {
  const ref = useRef(null);
  const [, setPref] = useState(getPreference);
  useEffect(() => subscribe(setPref), []);
  useLayoutEffect(() => {
    themeReport(ref.current, resolveTheme() === 'dark');
  });
  return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
