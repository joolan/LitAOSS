import { PendingUpload } from './types';

let seq = 0;
const makeId = () => `q${Date.now().toString(36)}-${++seq}`;

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () =>
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
          } else {
            all.push(...batch);
            readBatch();
          }
        },
        reject,
      );
    readBatch();
  });
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: PendingUpload[]) {
  if (entry.isFile) {
    const file = await entryToFile(entry as FileSystemFileEntry);
    out.push({ id: makeId(), path: prefix + entry.name, file, size: file.size });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) {
      await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

export async function collectDroppedFiles(dt: DataTransfer): Promise<PendingUpload[]> {
  const items = Array.from(dt.items || []);
  const entries: (FileSystemEntry | null)[] = items.map((it) =>
    it.kind === 'file' ? it.webkitGetAsEntry?.() ?? null : null,
  );

  const out: PendingUpload[] = [];
  if (entries.some((e) => e !== null)) {
    for (const entry of entries) {
      if (entry) await walkEntry(entry, '', out);
    }
  } else if (dt.files && dt.files.length > 0) {
    for (const file of Array.from(dt.files)) {
      out.push({ id: makeId(), path: file.name, file, size: file.size });
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function collectPickedFiles(fileList: FileList): PendingUpload[] {
  const out: PendingUpload[] = Array.from(fileList).map((file) => ({
    id: makeId(),
    path: file.webkitRelativePath || file.name,
    file,
    size: file.size,
  }));
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
