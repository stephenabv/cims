/**
 * The kiosk device token identifies a registered attendance terminal. It only authorises
 * submitting punches (each still needs the employee's account number and PIN), so browser
 * storage on the dedicated device is an acceptable trade-off. It is never sent with session calls.
 */
const KEY = 'cims.kioskDeviceToken';
const TOKEN_PATTERN = /^kio_[A-Za-z0-9_-]{20,120}$/;

export const isValidDeviceToken = (t: string) => TOKEN_PATTERN.test(t.trim());

export function readDeviceToken(): string | null {
  try {
    const t = localStorage.getItem(KEY);
    return t && isValidDeviceToken(t) ? t : null;
  } catch {
    return null;
  }
}

export function saveDeviceToken(token: string): void {
  localStorage.setItem(KEY, token.trim());
}

export function clearDeviceToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}
