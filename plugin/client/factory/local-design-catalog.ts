/** Read-only SQLite table decoding for browser-granted Open Design folders (no native bridge). */
import type { DesignDirectory } from './local-design.ts';
export interface LocalDesignMetadata { projectId: string; projectName: string; sourceUpdatedAt: number; directionId?: string; designSystemId?: string }
export async function readLocalCatalogMetadata(directory: DesignDirectory): Promise<LocalDesignMetadata[]> {
  const file = await directory.getFileHandle('app.sqlite').then(h => h.getFile());
  let database = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(database.subarray(0, 16)) !== 'SQLite format 3\0') throw new Error('Open Design catalog is not a SQLite database.');
  const header = new DataView(database.buffer); const size = header.getUint16(16) === 1 ? 65536 : header.getUint16(16), usable = size - header.getUint8(20);
  if (size < 512 || size > 65536 || (size & (size - 1)) !== 0) throw new Error('Invalid catalog page size.');
  // A closed Electron app may leave a committed WAL. Apply only complete committed frames.
  try {
    const wal = new Uint8Array(await (await directory.getFileHandle('app.sqlite-wal').then(h => h.getFile())).arrayBuffer()); const view = new DataView(wal.buffer);
    if (wal.length >= 32 && [0x377f0682, 0x377f0683].includes(view.getUint32(0)) && (view.getUint32(8) || 65536) === size) {
      const frames: Array<{ page: number; offset: number }> = []; let committed = 0, pages = 0;
      for (let offset = 32; offset + 24 + size <= wal.length; offset += 24 + size) {
        if (view.getUint32(offset + 8) !== view.getUint32(16) || view.getUint32(offset + 12) !== view.getUint32(20)) break;
        const page = view.getUint32(offset); if (!page || page > 100000) break;
        frames.push({ page, offset: offset + 24 }); if (view.getUint32(offset + 4)) { committed = frames.length; pages = view.getUint32(offset + 4); }
      }
      if (committed && pages > 0 && pages <= 100000) { const next = new Uint8Array(pages * size); next.set(database.subarray(0, next.length)); for (const f of frames.slice(0, committed)) if (f.page <= pages) next.set(wal.subarray(f.offset, f.offset + size), (f.page - 1) * size); database = next; }
    }
  } catch { /* No WAL; main catalog is still readable. */ }
  const view = new DataView(database.buffer);
  const encoding = view.getUint32(56); const decoder = new TextDecoder(encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8');
  const varint = (bytes: Uint8Array, at: number): [number, number] => { let n = 0; for (let i = 0; i < 9; i++) { if (at + i >= bytes.length) throw new Error('Truncated catalog integer'); const b = bytes[at+i]; n = n * (i === 8 ? 256 : 128) + (i === 8 ? b : b & 127); if (i === 8 || b < 128) return [n, at+i+1]; } throw new Error('Invalid integer'); };
  const record = (bytes: Uint8Array): unknown[] => {
    const [length, first] = varint(bytes, 0); let at = first, body = length; const result: unknown[] = [];
    while (at < length) {
      const [type, end] = varint(bytes, at); at = end;
      if (type === 0) { result.push(null); continue; }
      if (type === 8 || type === 9) { result.push(type - 8); continue; }
      const width = type === 1 ? 1 : type === 2 ? 2 : type === 3 ? 3 : type === 4 ? 4 : type === 5 ? 6 : type === 6 || type === 7 ? 8 : type >= 12 ? Math.floor((type - 12) / 2) : 0;
      if ((type === 10 || type === 11) || body + width > bytes.length) throw new Error('Truncated catalog record');
      const value = bytes.subarray(body, body + width); body += width;
      if (type >= 12) result.push(type % 2 ? decoder.decode(value) : value);
      else if (type === 7) result.push(new DataView(value.buffer, value.byteOffset, width).getFloat64(0));
      else { let integer = 0; for (const byte of value) integer = integer * 256 + byte; if (value[0] & 128) integer -= 2 ** (width * 8); result.push(integer); }
    }
    return result;
  };
  const table = (root: number): unknown[][] => {
    const rows: unknown[][] = [], visited = new Set<number>();
    const page = (number: number) => {
      if (visited.has(number) || number < 1 || number * size > database.length) throw new Error('Invalid catalog B-tree'); visited.add(number);
      const start = (number - 1) * size, offset = start + (number === 1 ? 100 : 0), type = view.getUint8(offset), count = view.getUint16(offset + 3);
      if (type !== 5 && type !== 13) throw new Error('Unsupported catalog table');
      for (let i = 0; i < count; i++) {
        const cell = start + view.getUint16(offset + (type === 5 ? 12 : 8) + i * 2);
        if (type === 5) { page(view.getUint32(cell)); continue; }
        const [length, at] = varint(database, cell), [, payload] = varint(database, at);
        const max = usable - 35, min = Math.floor((usable - 12) * 32 / 255) - 23;
        let local = length <= max ? length : min + (length - min) % (usable - 4); if (local > max) local = min;
        if (length > 64 * 1024 * 1024) throw new Error('Catalog record too large');
        const bytes = new Uint8Array(length); bytes.set(database.subarray(payload, payload + local));
        let filled = local, overflow = length > local ? view.getUint32(payload + local) : 0; const seen = new Set<number>();
        while (overflow && filled < length) {
          if (seen.has(overflow) || overflow * size > database.length) throw new Error('Invalid catalog overflow'); seen.add(overflow);
          const p = (overflow - 1) * size, take = Math.min(length - filled, usable - 4); bytes.set(database.subarray(p + 4, p + 4 + take), filled); filled += take; overflow = view.getUint32(p);
        }
        if (filled !== length) throw new Error('Incomplete catalog payload'); rows.push(record(bytes));
      }
      if (type === 5) page(view.getUint32(offset + 8));
    };
    page(root); return rows;
  };
  const entry = table(1).find(row => row[0] === 'table' && row[1] === 'projects'); if (!entry) return [];
  const columns = String(entry[4]).slice(String(entry[4]).indexOf('(') + 1).split(',').map(c => /^\s*["`\[]?([\w_]+)/.exec(c)?.[1]);
  return table(Number(entry[3])).map(values => {
    const row = Object.fromEntries(columns.map((name, i) => [name, values[i]])); let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(String(row.metadata_json ?? '{}')); } catch { /* optional */ }
    return { projectId: String(row.id), projectName: String(row.name ?? row.id), sourceUpdatedAt: Number(row.updated_at) || Date.parse(String(row.updated_at)) || 0, directionId: typeof metadata.directionId === 'string' ? metadata.directionId : typeof row.skill_id === 'string' ? row.skill_id : undefined, designSystemId: typeof row.design_system_id === 'string' ? row.design_system_id : undefined };
  });
}
