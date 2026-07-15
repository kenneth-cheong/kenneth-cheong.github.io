// Turning URL-ish table cells into real links.
//
// Data tools emit URLs under whatever column name reads best — Backlinks
// Explorer uses From/To, Anchor Text Cleaner uses "Links to", the crawler uses
// "Source page". Keying off the column name (the old rule only linkified a
// column literally called `url`) left all of those as dead text, so a user who
// spots a broken backlink can't click through to go fix it.
//
// Detection is by VALUE, and deliberately conservative: a wrong link is worse
// than plain text, so anything with whitespace, any bare filename (sitemap.xml)
// and anything without a plausible host is left alone.

const FILE_EXT = /\.(html?|xml|txt|json|css|js|mjs|png|jpe?g|gif|webp|svg|pdf|csv|zip|md)$/i;
const HOST_PATH = /^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(\/\S*)?$/i;

// → absolute href, or null when the value isn't a link.
export function toHref(value) {
  const s = String(value ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^www\./i.test(s)) return `https://${s}`;

  const m = HOST_PATH.exec(s);
  if (!m) return null;
  const [, host, path] = m;
  if (!/\.[a-z]{2,24}$/i.test(host)) return null; // needs an alphabetic TLD
  if (!path && FILE_EXT.test(host)) return null;  // "sitemap.xml" is a file, not a host
  return `https://${s}`;
}

// Drop the scheme so long URLs stay scannable in a table.
export function linkLabel(value) {
  return String(value ?? '').trim().replace(/^https?:\/\//i, '');
}

// A cell rendered as a link when it looks like one, plain text otherwise.
// Opens in a new tab: the point is to check the page without losing the report.
export function CellLink({ value, className = '' }) {
  const href = toHref(value);
  if (!href) return String(value ?? '');
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer nofollow"
      title={String(value ?? '')}
      className={`break-all text-brand-600 dark:text-brand-400 hover:underline ${className}`}
    >
      {linkLabel(value)}
    </a>
  );
}
