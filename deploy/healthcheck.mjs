const port = Number(process.env.CHECKIN_PORT || 8765);

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
    cache: 'no-store',
  });
  const health = response.ok ? await response.json() : null;
  if (health?.status !== 'ok' || health.runtime !== 'node') process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
