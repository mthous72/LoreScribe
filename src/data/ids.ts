/**
 * UUIDv7 — time-ordered, so ids sort by creation and index locality is good.
 * The schema's stated convention (db/schema.sql header) is UUIDv7 TEXT.
 */
export function uuidv7(now: number = Date.now()): string {
  const ts = BigInt(now);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(40 - 8 * i)) & 0xffn);
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DEVICE_KEY = 'lorescribe.device_id';

/**
 * Stable per-device identifier for op_log attribution. localStorage is the right
 * home: it must survive a database wipe, since its job is to distinguish this
 * device's writes from another's if sync is ever built.
 */
export function deviceId(): string {
  let id: string | null = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch { /* private mode */ }
  if (id) return id;
  id = uuidv7();
  try { localStorage.setItem(DEVICE_KEY, id); } catch { /* ephemeral, fine */ }
  return id;
}
