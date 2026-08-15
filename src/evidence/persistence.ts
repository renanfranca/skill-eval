import { constants, link, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { integrityError } from '../errors.js';
import { canonicalJson } from '../spec/canonical.js';

export async function ensureNewDirectory(directory: string, mode = 0o700): Promise<void> {
  try {
    await mkdir(directory, { mode });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw integrityError(`Refusing to reuse existing path: ${directory}`);
    }
    throw error;
  }
}

export async function writeCreateOnly(filePath: string, bytes: string | Uint8Array, mode = 0o600): Promise<void> {
  const parent = path.dirname(filePath);
  const temp = path.join(parent, `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw integrityError(`Refusing to overwrite existing artifact: ${filePath}`);
    }
    throw error;
  }
  await unlink(temp);
  const directoryHandle = await open(parent, constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export async function writeJsonCreateOnly(filePath: string, value: unknown): Promise<void> {
  await writeCreateOnly(filePath, canonicalJson(value));
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_APPEND);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
