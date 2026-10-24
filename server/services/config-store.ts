import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export type PersistedFolderConfiguration = { version: 1; sourcePath: string | null; destinationPaths: string[] };
export type ConfigurationLoadResult = { configuration: PersistedFolderConfiguration; recoveryRequired: boolean; warning?: string };

export class ConfigurationStoreError extends Error {
  constructor(message: string, readonly statusCode = 500) { super(message); }
}

export function defaultConfigurationPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  let directory: string;
  if (platform === 'win32') directory = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') directory = path.join(home, 'Library', 'Application Support');
  else {
    const xdg = env.XDG_CONFIG_HOME;
    directory = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  }
  return path.join(directory, 'kilkul-media-sorter', 'config.json');
}

const emptyConfiguration = (): PersistedFolderConfiguration => ({ version: 1, sourcePath: null, destinationPaths: [] });

function parseConfiguration(raw: string): PersistedFolderConfiguration {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ConfigurationStoreError('The saved folder configuration is malformed.', 409); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationStoreError('The saved folder configuration has an invalid structure.', 409);
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new ConfigurationStoreError('The saved folder configuration uses an unsupported version.', 409);
  const validStoredPath = (candidate: unknown): candidate is string => typeof candidate === 'string' && candidate.length <= 32760 && !/[\u0000-\u001f]/.test(candidate) && path.isAbsolute(candidate);
  if (Object.keys(record).some(key => !['version', 'sourcePath', 'destinationPaths'].includes(key)) ||
      !(record.sourcePath === null || validStoredPath(record.sourcePath)) ||
      !Array.isArray(record.destinationPaths) || record.destinationPaths.length > 1000 || record.destinationPaths.some(item => !validStoredPath(item)) ||
      new Set(record.destinationPaths).size !== record.destinationPaths.length) {
    throw new ConfigurationStoreError('The saved folder configuration has an invalid structure.', 409);
  }
  return { version: 1, sourcePath: record.sourcePath as string | null, destinationPaths: [...record.destinationPaths] as string[] };
}

export class ConfigurationStore {
  readonly filePath: string;
  private recoveryRequired = false;
  private recoveryWarning: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath = defaultConfigurationPath()) { this.filePath = path.resolve(filePath); }

  async load(): Promise<ConfigurationLoadResult> {
    this.recoveryRequired = false;
    this.recoveryWarning = undefined;
    try {
      const configuration = parseConfiguration(await readFile(this.filePath, 'utf8'));
      return { configuration, recoveryRequired: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          const backup = parseConfiguration(await readFile(`${this.filePath}.bak`, 'utf8'));
          this.recoveryWarning = 'The main configuration file was missing; the previous valid backup is active.';
          return { configuration: backup, recoveryRequired: false, warning: 'The main configuration file was missing; the previous valid backup is active.' };
        } catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') return { configuration: emptyConfiguration(), recoveryRequired: false };
          if (backupError instanceof ConfigurationStoreError) {
            this.recoveryRequired = true;
            this.recoveryWarning = 'The main configuration file is missing and its backup is invalid. Both files were preserved; explicit recovery is required.';
            return { configuration: emptyConfiguration(), recoveryRequired: true, warning: this.recoveryWarning };
          }
          this.recoveryRequired = true;
          this.recoveryWarning = 'The saved folder configuration and its backup could not be read. They were preserved; explicit recovery is required.';
          return { configuration: emptyConfiguration(), recoveryRequired: true, warning: this.recoveryWarning };
        }
      }
      if (error instanceof ConfigurationStoreError) {
        this.recoveryRequired = true;
        this.recoveryWarning = `${error.message} The file was preserved. Explicit recovery is required before changing folders.`;
        return { configuration: emptyConfiguration(), recoveryRequired: true, warning: this.recoveryWarning };
      }
      const code = (error as NodeJS.ErrnoException).code;
      this.recoveryRequired = true;
      this.recoveryWarning = code === 'EACCES' || code === 'EPERM'
        ? 'The saved folder configuration cannot be read because access was denied. It was preserved; explicit recovery is required.'
        : 'The saved folder configuration could not be read. It was preserved; explicit recovery is required.';
      return { configuration: emptyConfiguration(), recoveryRequired: true, warning: this.recoveryWarning };
    }
  }

  getRecoveryStatus(): { recoveryRequired: boolean; warning?: string } {
    return { recoveryRequired: this.recoveryRequired, ...(this.recoveryWarning ? { warning: this.recoveryWarning } : {}) };
  }

  save(configuration: PersistedFolderConfiguration): Promise<void> {
    return this.enqueue(async () => {
      if (this.recoveryRequired) throw new ConfigurationStoreError('Recover the saved configuration explicitly before changing folders.', 409);
      await this.writeValidConfiguration(configuration);
      this.recoveryWarning = undefined;
    });
  }

  recoverWithEmptyConfiguration(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.recoveryRequired) throw new ConfigurationStoreError('There is no invalid configuration file that requires recovery.', 409);
      if (this.recoveryRequired) {
        const backupPath = `${this.filePath}.invalid-${randomUUID()}.bak`;
        try {
          await mkdir(path.dirname(this.filePath), { recursive: true });
          let existingPath = this.filePath;
          try { await stat(existingPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            existingPath = `${this.filePath}.bak`;
          }
          await copyFile(existingPath, backupPath, constants.COPYFILE_EXCL);
          const backupHandle = await open(backupPath, 'r+');
          try { await backupHandle.sync(); } finally { await backupHandle.close(); }
        } catch {
          throw new ConfigurationStoreError('The invalid configuration could not be backed up; it was left unchanged and recovery was not performed.');
        }
      }
      await this.writeValidConfiguration(emptyConfiguration());
      this.recoveryRequired = false;
      this.recoveryWarning = undefined;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async writeValidConfiguration(configuration: PersistedFolderConfiguration): Promise<void> {
    // Round-trip through the same strict parser before any filesystem changes.
    const normalized = parseConfiguration(JSON.stringify(configuration));
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(directory, `.config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }

      // Preserve the previous valid bytes before replacement. This is a recovery copy,
      // not a claim of a cross-platform transactional commit.
      try {
        await stat(this.filePath);
        const backup = `${this.filePath}.bak`;
        await copyFile(this.filePath, backup);
        const backupHandle = await open(backup, 'r+');
        try { await backupHandle.sync(); } finally { await backupHandle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (process.platform === 'win32') {
        const displacedPath = `${this.filePath}.replaced-${process.pid}-${Date.now()}.tmp`;
        let displaced = false;
        try {
          try { await rename(this.filePath, displacedPath); displaced = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await rename(temporaryPath, this.filePath);
          if (displaced) await rm(displacedPath, { force: true }).catch(() => undefined);
        } catch (error) {
          if (displaced) {
            try { await rename(displacedPath, this.filePath); } catch { /* The .bak copy remains available for recovery. */ }
          }
          throw error;
        }
      } else await rename(temporaryPath, this.filePath);
      try { const dirHandle = await open(directory, 'r'); try { await dirHandle.sync(); } finally { await dirHandle.close(); } } catch { /* Directory syncing is not supported on every platform. */ }
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof ConfigurationStoreError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new ConfigurationStoreError(code === 'EACCES' || code === 'EPERM'
        ? 'Folder configuration could not be saved because access was denied.'
        : 'Folder configuration could not be saved. The previous configuration remains active.');
    }
  }
}
