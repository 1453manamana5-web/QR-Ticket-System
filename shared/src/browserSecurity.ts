/** Popup documents render generated print markup, never executable content. */
export const printContentSecurityPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'";

/** GitHub Pages cannot supply frame-ancestors headers. Fail closed before auth
 * or app startup when embedded, including same-origin and sandboxed frames. */
export function blockEmbeddedApp(root: HTMLElement, browser: Pick<Window, 'self' | 'top' | 'location'>): boolean {
  let embedded = true;
  try { embedded = browser.self !== browser.top; } catch { /* inaccessible parent */ }
  if (!embedded) return false;
  const document = root.ownerDocument;
  const message = document.createElement('p');
  message.textContent = '安全のため、埋め込み画面では操作できません。アプリを別のウィンドウで開いてください。';
  const link = document.createElement('a');
  link.textContent = 'アプリを開く';
  link.href = browser.location.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  root.replaceChildren(message, link);
  root.dataset.securityBlocked = 'embedded';
  return true;
}
