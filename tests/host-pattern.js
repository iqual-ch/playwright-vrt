/** "*.example.com" matches example.com and any subdomain; plain hosts match exactly. */
export function hostPatternToRegExp(pattern) {
  // "*" stays unescaped so a leading wildcard can be detected below.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (escaped.startsWith('*\\.')) {
    const base = escaped.slice(3);
    return new RegExp(`^(?:.+\\.)?${base}$`, 'i');
  }
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
}

/** Chromium --host-resolver-rules entries that make a pattern unresolvable ("MAP host ~NOTFOUND"). */
export function hostPatternToResolverRules(pattern) {
  const rules = [`MAP ${pattern} ~NOTFOUND`];
  // Like hostPatternToRegExp, "*.example.com" also covers the bare domain.
  if (pattern.startsWith('*.')) rules.push(`MAP ${pattern.slice(2)} ~NOTFOUND`);
  return rules;
}
