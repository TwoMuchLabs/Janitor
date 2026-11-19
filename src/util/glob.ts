/**
 * Minimal glob matcher for repo-relative, forward-slash paths.
 * Supports `**`, `*`, `?` and `{a,b}` alternation.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth > 0) {
      depth--;
      re += ')';
    } else if (c === ',' && depth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function makeMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
}
