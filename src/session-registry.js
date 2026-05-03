export const mainSessionsBySessionId = new Map();

export function rememberSession(session) {
  const sessionId = session?.sessionManager?.getSessionId?.();
  if (!sessionId) return null;
  mainSessionsBySessionId.set(sessionId, session);
  return sessionId;
}

export function getSession(sessionId) {
  return mainSessionsBySessionId.get(sessionId) ?? null;
}
