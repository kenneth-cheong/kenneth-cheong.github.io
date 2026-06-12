// Admin access is an allowlist of emails in the ADMIN_EMAILS env var
// (comma-separated). Set it on the AdminFn + MeFn + AuthFn in template.yaml.
export function isAdmin(email) {
  const allow = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes((email || '').toLowerCase());
}
