// Shared polling logic for the authorized Android isolation device check.
export const sameActiveDiagnostic = (expectedPid, actualPid, result) =>
  Number.isSafeInteger(expectedPid) && expectedPid > 0 &&
  Number(actualPid) === expectedPid && result?.state === "ready" && result.pid === expectedPid;

export async function observeTraffic({
  start, read, wait, isActive = async () => true, now = Date.now, timeoutMs = 12000
}) {
  const active = async () => {
    try { return await isActive() === true; } catch { return false; }
  };
  const expired = () => ({failure:"diagnostic_not_active"});
  if (!await active()) return expired();
  await start();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!await active()) return expired();
    let result;
    try { result = await read(); } catch {}
    // A successful request after the diagnostic deadline does not prove coexistence.
    if (!await active()) return expired();
    if (result) return {result};
    await wait(150);
  }
  return {failure:"traffic_timeout"};
}
