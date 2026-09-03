export function redactSessionKey(sk) {
  return String(sk ?? "").replace(/\d{5,}/g, (m) => "…" + m.slice(-4));
}
