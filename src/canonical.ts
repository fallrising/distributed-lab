// Key-sorted canonical JSON used for every observation comparison (ADR D2, D11).
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Map) return canonicalize(Object.fromEntries([...value.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1))));
  if (value instanceof Set) return [...value].map(canonicalize).sort();
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[k]);
  }
  return value;
}
