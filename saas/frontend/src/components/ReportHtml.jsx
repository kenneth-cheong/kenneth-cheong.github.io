import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getPreference, isDarkTheme, subscribe } from '../lib/theme.js';
import { themeReport } from '../lib/reportTheme.js';

// The Media Plan's execution grid is 20 columns wide — it cannot fit a portrait
// sheet, and the print CSS can't fix that alone because `@page` takes no
// selector: there's no way to say "landscape only when this table is present".
// So flip the sheet from JS while such a table is on the page. Hooked to
// `beforeprint` rather than the Print button so Cmd+P and the browser menu are
// covered too, and `size: landscape` (not `A4 landscape`) so it changes the
// orientation without overriding the user's paper size.
const LANDSCAPE_ID = 'dm-print-landscape';
function useLandscapeWhenWide(ref, html) {
  useEffect(() => {
    if (!ref.current?.querySelector('.mp-exec-table')) return undefined;
    const on = () => {
      if (document.getElementById(LANDSCAPE_ID)) return;
      const style = document.createElement('style');
      style.id = LANDSCAPE_ID;
      style.textContent = '@page { size: landscape; margin: 10mm; }';
      document.head.appendChild(style);
    };
    const off = () => document.getElementById(LANDSCAPE_ID)?.remove();
    window.addEventListener('beforeprint', on);
    window.addEventListener('afterprint', off);
    return () => {
      window.removeEventListener('beforeprint', on);
      window.removeEventListener('afterprint', off);
      off();
    };
  }, [ref, html]);
}

// Renders server-provided report HTML (dangerouslySetInnerHTML) and normalizes
// its inline light-themed colors for dark mode (see lib/reportTheme.js). The
// transform re-runs whenever the html changes OR the theme flips. useLayoutEffect
// applies it before paint, so there's no flash of the light document.
export default function ReportHtml({ html, className = 'dm-report max-w-none text-sm text-body' }) {
  const ref = useRef(null);
  const [, setPref] = useState(getPreference);
  useEffect(() => subscribe(setPref), []);
  useLayoutEffect(() => {
    // isDarkTheme(), not `=== 'dark'` — royal is a dark canvas too, and reports
    // arrive as light-themed inline-styled HTML that needs normalizing there.
    themeReport(ref.current, isDarkTheme());
  });
  useLandscapeWhenWide(ref, html);
  return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
