function pendingKey(sessionId, requestId) {
  return `${sessionId}/${requestId}`;
}

function makeWatchState() {
  return { hostexec: new Map(), network: new Map() };
}

// nas <domain> watch の 1 行 JSON を状態へ畳む。変化があったとき true。
function applyWatchEvent(state, event) {
  const bucket = state[event.domain];
  if (!bucket) return false;
  if (event.event === "added") {
    const key = pendingKey(event.entry.sessionId, event.entry.requestId);
    if (bucket.has(key)) return false;
    bucket.set(key, event.entry);
    return true;
  }
  if (event.event === "removed") {
    return bucket.delete(pendingKey(event.sessionId, event.requestId));
  }
  return false;
}

function pendingCount(state) {
  let n = 0;
  for (const bucket of Object.values(state)) n += bucket.size;
  return n;
}

module.exports = { applyWatchEvent, makeWatchState, pendingCount, pendingKey };
