import type { QueueItem } from '../data/placeholders';

const invalidFilenameCharacters = /[<>:"/\\|?*\u0000-\u001f]/;
const windowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot) : '';
}

export function validateRenamedFilename(
  proposedName: string,
  currentFilename: string,
  currentId: string,
  items: QueueItem[],
): { filename?: string; error?: string } {
  const extension = getExtension(currentFilename);
  let name = proposedName.trim();
  if (!name) return { error: 'Enter a filename.' };

  // Accept a full name if its existing extension is included; otherwise append it once.
  if (extension && /\.[^.]+$/.test(name)) {
    const enteredExtension = name.slice(name.lastIndexOf('.'));
    if (enteredExtension.toLowerCase() !== extension.toLowerCase()) {
      return { error: `Keep the existing ${extension} extension.` };
    }
    do { name = name.slice(0, -extension.length); }
    while (name.toLowerCase().endsWith(extension.toLowerCase()));
  }
  if (!name.trim()) return { error: 'The filename needs a name before its extension.' };
  if (invalidFilenameCharacters.test(name)) return { error: 'Use a name without \\ / : * ? " < > | or control characters.' };
  if (/[. ]$/.test(name)) return { error: 'Names cannot end with a period or space.' };
  if (windowsReservedName.test(name)) return { error: 'That name is reserved by Windows.' };

  const filename = `${name}${extension}`;
  if (items.some(item => item.id !== currentId && item.filename.toLocaleLowerCase() === filename.toLocaleLowerCase())) {
    return { error: 'Another placeholder already uses that filename.' };
  }
  return { filename };
}
