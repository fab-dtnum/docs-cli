// Écriture d'archives .zip, sans dépendance : `node:zlib` fournit la compression (deflate) et le CRC-32.
// Volontairement minimal : pas de zip64 (archive < 4 Go, < 65 535 fichiers), pas de chiffrement.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Chemin dans l'archive, avec des `/` : jamais absolu, jamais de `..`. */
  name: string;
  data: Buffer;
  date?: Date;
}

const MAX = 0xffffffff;

/** Date et heure au format MS-DOS (précision de 2 s, à partir de 1980), en heure locale. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function checkName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((p) => p === '..' || p === '')) {
    throw new Error(`Nom d'entrée refusé dans l'archive : ${name}`);
  }
}

export function zip(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('Trop de fichiers pour une archive zip (65 535 au plus).');
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, data, date = new Date() } of entries) {
    checkName(name);
    if (seen.has(name.toLowerCase())) throw new Error(`Entrée en double dans l'archive : ${name}`);
    seen.add(name.toLowerCase());

    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    if (data.length > MAX || body.length > MAX || offset > MAX) throw new Error('Archive zip trop volumineuse (4 Go).');
    const { time, date: day } = dosDateTime(date);
    const crc = crc32(data);
    const method = stored ? 0 : 8;
    const flags = 0x0800; // noms en UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version nécessaire
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // pas de champ supplémentaire
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // créée sous Unix, version 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // fichier ordinaire, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
