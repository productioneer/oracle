export function isDetachedFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("detached frame") ||
    normalized.includes("execution context was destroyed") ||
    normalized.includes("cannot find context with specified id") ||
    normalized.includes("target closed") ||
    normalized.includes("session closed")
  );
}
