/**
 * Copies text. Browsers only offer navigator.clipboard on https and localhost, so on a plain http LAN address this
 * falls back to the older copy command, which needs the text selected in a field on the page.
 */
export async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', ''); // keeps a phone's keyboard from opening
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  focused?.focus();
  if (!copied) throw new Error("Couldn't copy to the clipboard.");
}
