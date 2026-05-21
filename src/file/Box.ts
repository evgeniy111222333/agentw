import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { ConfigurationManager, FileConfig } from '../config/ConfigurationManager';

export type BoxArea = 'downloads' | 'uploads' | 'shots' | 'tmp';

export interface BoxFile {
  name: string;
  path: string;
  area?: BoxArea;
  size: number;
  mime_type: string;
  modified_at: string;
}

export interface BoxPut {
  info: BoxFile;
  absolutePath: string;
}

const AREAS: BoxArea[] = ['downloads', 'uploads', 'shots', 'tmp'];
const AREA_SET = new Set<string>(AREAS);

export class Box {
  constructor(private overrides: Partial<FileConfig> = {}) {}

  async sessionRoot(sessionId: string): Promise<string> {
    const root = path.resolve(this.config().root_dir, safeSegment(sessionId));
    await fs.mkdir(root, { recursive: true });
    await Promise.all(AREAS.map((area) => fs.mkdir(path.join(root, area), { recursive: true })));
    return root;
  }

  async reserve(sessionId: string, area: BoxArea, requestedName?: string): Promise<{ absolutePath: string; path: string }> {
    const root = await this.sessionRoot(sessionId);
    const base = cleanName(requestedName || `${area}-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const absolutePath = await this.uniquePath(path.join(root, area, base));
    return {
      absolutePath,
      path: this.relative(root, absolutePath),
    };
  }

  async put(
    sessionId: string,
    area: BoxArea,
    requestedName: string | undefined,
    data: Buffer | string,
    encoding: BufferEncoding = 'utf8'
  ): Promise<BoxPut> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
    this.checkSize(buffer.byteLength);
    const target = await this.reserve(sessionId, area, requestedName);
    await this.checkSessionQuota(sessionId, buffer.byteLength);
    await fs.writeFile(target.absolutePath, buffer);
    return {
      info: await this.info(sessionId, target.absolutePath),
      absolutePath: target.absolutePath,
    };
  }

  async writePath(
    sessionId: string,
    filePath: string,
    data: Buffer | string,
    encoding: BufferEncoding = 'utf8'
  ): Promise<BoxPut> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
    this.checkSize(buffer.byteLength);
    const absolutePath = await this.filePath(sessionId, filePath, 'tmp');
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const existing = await fs.stat(absolutePath).then((stat) => stat.isFile() ? stat.size : 0).catch(() => 0);
    await this.checkSessionQuota(sessionId, buffer.byteLength - existing);
    await fs.writeFile(absolutePath, buffer);
    return {
      info: await this.info(sessionId, absolutePath),
      absolutePath,
    };
  }

  async filePath(sessionId: string, requestedPath: string, defaultArea: BoxArea = 'tmp'): Promise<string> {
    const root = await this.sessionRoot(sessionId);
    const value = String(requestedPath ?? '').trim();
    const normalized = value ? stripLeadingSeparators(value) : defaultArea;
    const absolutePath = isDriveAbsolute(value) ? path.resolve(value) : path.resolve(root, normalized);
    if (!inside(root, absolutePath)) {
      throw new Error('File path escapes session sandbox');
    }
    return absolutePath;
  }

  async info(sessionId: string, absolutePath: string): Promise<BoxFile> {
    const root = await this.sessionRoot(sessionId);
    if (!inside(root, absolutePath)) throw new Error('File path escapes session sandbox');
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new Error('Path is not a file');
    const rel = this.relative(root, absolutePath);
    const first = rel.split('/')[0];
    return {
      name: path.basename(absolutePath),
      path: rel,
      area: AREA_SET.has(first) ? first as BoxArea : undefined,
      size: stat.size,
      mime_type: mimeFor(absolutePath),
      modified_at: stat.mtime.toISOString(),
    };
  }

  async adoptReservedFile(sessionId: string, absolutePath: string): Promise<BoxFile> {
    const info = await this.info(sessionId, absolutePath);
    this.checkSize(info.size);
    try {
      await this.checkSessionQuota(sessionId, 0);
    } catch (error) {
      await fs.rm(absolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
    return info;
  }

  async list(sessionId: string, requestedPath = '.', recursive = false): Promise<Array<BoxFile & { type: 'file' | 'directory' }>> {
    const root = await this.sessionRoot(sessionId);
    const base = await this.filePath(sessionId, requestedPath || '.', 'tmp');
    if (!inside(root, base)) throw new Error('File path escapes session sandbox');
    const stat = await fs.stat(base).catch(() => undefined);
    if (!stat) return [];
    if (stat.isFile()) {
      return [{ ...(await this.info(sessionId, base)), type: 'file' }];
    }
    if (!stat.isDirectory()) throw new Error('Path is not listable');

    const entries = await this.walk(sessionId, base, recursive);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(sessionId: string, requestedPath: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<BoxFile & { content: string; encoding: string }> {
    const absolutePath = await this.filePath(sessionId, requestedPath, 'tmp');
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new Error('Path is not a file');
    this.checkSize(stat.size);
    const buffer = await fs.readFile(absolutePath);
    return {
      ...(await this.info(sessionId, absolutePath)),
      content: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
      encoding,
    };
  }

  async delete(sessionId: string, requestedPath: string): Promise<{ deleted: true; path: string }> {
    if (!this.config().allow_delete) throw new Error('File delete is disabled');
    const root = await this.sessionRoot(sessionId);
    const absolutePath = await this.filePath(sessionId, requestedPath, 'tmp');
    if (absolutePath === root) throw new Error('Cannot delete session root');
    await fs.rm(absolutePath, { recursive: true, force: false });
    return { deleted: true, path: this.relative(root, absolutePath) };
  }

  private config(): FileConfig {
    return {
      ...ConfigurationManager.getInstance().getConfig().file,
      ...this.overrides,
    };
  }

  private checkSize(bytes: number): void {
    if (bytes > this.config().max_file_bytes) {
      throw new Error(`File exceeds max_file_bytes (${this.config().max_file_bytes})`);
    }
  }

  private async checkSessionQuota(sessionId: string, additionalBytes: number): Promise<void> {
    const max = this.config().max_session_bytes;
    if (max <= 0) return;
    const used = await this.sessionBytes(sessionId);
    const next = used + Math.max(0, additionalBytes);
    if (next > max) {
      throw new Error(`Session file quota exceeded (${next}/${max} bytes)`);
    }
  }

  private async sessionBytes(sessionId: string): Promise<number> {
    const root = await this.sessionRoot(sessionId);
    let total = 0;
    const visit = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(absolutePath);
        else if (entry.isFile()) total += (await fs.stat(absolutePath)).size;
      }
    };
    await visit(root);
    return total;
  }

  private async uniquePath(initial: string): Promise<string> {
    const ext = path.extname(initial);
    const stem = initial.slice(0, initial.length - ext.length);
    let candidate = initial;
    for (let index = 1; index <= 100; index += 1) {
      if (!(await exists(candidate))) return candidate;
      candidate = `${stem}-${index}${ext}`;
    }
    throw new Error('Cannot allocate unique file path');
  }

  private relative(root: string, absolutePath: string): string {
    return `/${path.relative(root, absolutePath).split(path.sep).join('/')}`;
  }

  private async walk(sessionId: string, dir: string, recursive: boolean): Promise<Array<BoxFile & { type: 'file' | 'directory' }>> {
    const root = await this.sessionRoot(sessionId);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const result: Array<BoxFile & { type: 'file' | 'directory' }> = [];
    for (const dirent of dirents) {
      const absolutePath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        const stat = await fs.stat(absolutePath);
        result.push({
          name: dirent.name,
          path: this.relative(root, absolutePath),
          area: areaFromRelative(this.relative(root, absolutePath)),
          size: 0,
          mime_type: 'inode/directory',
          modified_at: stat.mtime.toISOString(),
          type: 'directory',
        });
        if (recursive) result.push(...await this.walk(sessionId, absolutePath, true));
      } else if (dirent.isFile()) {
        result.push({ ...(await this.info(sessionId, absolutePath)), type: 'file' });
      }
    }
    return result;
  }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return safe || 'session';
}

function cleanName(value: string): string {
  const base = path.basename(value.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || `file-${Date.now()}`;
}

function stripLeadingSeparators(value: string): string {
  return value.replace(/^[\\/]+/, '');
}

function isDriveAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function areaFromRelative(rel: string): BoxArea | undefined {
  const first = rel.replace(/^\//, '').split('/')[0];
  return AREA_SET.has(first) ? first as BoxArea : undefined;
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.txt' || ext === '.log' || ext === '.md') return 'text/plain';
  return 'application/octet-stream';
}
