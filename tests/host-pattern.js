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

/** Chromium --host-resolver-rules entries that make a pattern's hosts unresolvable. */
export function hostPatternToResolverRules(hostPattern) {
  const pattern = hostPattern.toLowerCase();
  const rules = [`MAP ${pattern} ~NOTFOUND`];
  if (pattern.startsWith('*.')) rules.push(`MAP ${pattern.slice(2)} ~NOTFOUND`);
  return rules;
}

/** CDP Fetch URL patterns for a pattern's hosts. They over-match, so check the hostname. */
export function hostPatternToUrlPatterns(hostPattern) {
  const pattern = hostPattern.toLowerCase();
  const patterns = [`*://${pattern}*`];
  if (pattern.startsWith('*.')) patterns.push(`*://${pattern.slice(2)}*`);
  return patterns;
}
