import fs from 'node:fs';
import path from 'node:path';
import { MediaError, MEDIA_PREFIX, MAX_AUDIO_BYTES, inspectMediaBytes, isMediaFilename, isLegacyFilename, newMediaFilename } from './media-storage.js';

export function localMediaStore(directory) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    put(bytes, info) {
      const filename = newMediaFilename(info.extension);
      // Exclusive creation: replacing question media always creates a new asset.
      fs.writeFileSync(path.join(root, filename), bytes, { flag: 'wx', mode: 0o600 });
      return { ...info, filename, url: `${MEDIA_PREFIX}${filename}` };
    },
    get(filename, { legacy = false } = {}) {
      if (!(legacy ? isLegacyFilename(filename) : isMediaFilename(filename))) return null;
      const file = path.join(root, filename);
      let fd;
      try {
        // No path components or symlinks can escape the dedicated media root.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_AUDIO_BYTES) return null;
        const bytes = fs.readFileSync(fd);
        const info = inspectMediaBytes(bytes);
        return { bytes, ...info };
      } catch (error) {
        if (['ENOENT', 'ELOOP', 'EISDIR'].includes(error.code) || error instanceof MediaError) return null;
        throw error;
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    },
  };
}
