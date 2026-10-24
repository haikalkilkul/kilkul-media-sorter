export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}
