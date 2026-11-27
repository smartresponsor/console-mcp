// Same-target session observation: return only a boolean, never a session body.
export function buildChatGptTargetAuthProbeExpression(expectedHref: string): string {
  return `(async () => {
    const expected = ${JSON.stringify(expectedHref)};
    const stable = () => location.origin === 'https://chatgpt.com'
      && location.href === expected && document.visibilityState === 'visible'
      && document.hasFocus();
    if (!stable()) return { authenticated: false };
    try {
      const response = await fetch('/api/auth/session', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: AbortSignal.timeout(3000)
      });
      if (!response.ok || !stable()) return { authenticated: false };
      const session = await response.json();
      return { authenticated: stable() && !!(session && typeof session.user === 'object'
        && session.user !== null && typeof session.expires === 'string'
        && Date.parse(session.expires) > Date.now()) };
    } catch { return { authenticated: false }; }
  })()`;
}
