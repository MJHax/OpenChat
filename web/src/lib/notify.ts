const ASKED_KEY = 'openchat.video.notifyAsked';

/** Asks once (on the first video Generate) whether OpenChat may show a notification when a clip is done. */
export function askNotifyPermission(): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default' || localStorage.getItem(ASKED_KEY)) return;
    localStorage.setItem(ASKED_KEY, '1');
    void Notification.requestPermission();
  } catch {
    // storage blocked: just don't ask
  }
}

/** A system notification when the tab is hidden and the user allowed it; clicking it opens the thread. */
export function systemNotify(title: string, threadId: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  const n = new Notification('Your clip finished', { body: title });
  n.onclick = () => { window.focus(); window.location.hash = `#/video/${threadId}`; n.close(); };
}
