// Admin access is an allowlist of emails in the ADMIN_EMAILS env var
// (comma-separated). Set it on the AdminFn + MeFn + AuthFn in template.yaml.
export function isAdmin(email) {
  const allow = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes((email || '').toLowerCase());
}

// Staff = the bootstrap ADMIN_EMAILS allowlist OR a per-user role flag granted
// from the admin "Create user" UI. Takes the full user record (not just email)
// so UI-promoted staff get access without an env change + redeploy.
export function isStaff(user) {
  if (!user) return false;
  return user.role === 'staff' || isAdmin(user.email);
}
