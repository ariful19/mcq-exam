// Runtime-neutral media rules shared by Express and the Worker. File names and
// declared MIME types are never used to decide what bytes may be served.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
export const MEDIA_PREFIX = '/api/media/';
const OBJECT_PREFIX = 'question-media/';
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
};
const MIME_ALIASES = { 'image/jpg': 'image/jpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-flac': 'audio/flac', 'application/ogg': 'audio/ogg' };
export class MediaError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'MediaError'; this.status = status; }
}
const ascii = (bytes, offset, text) => text.split('').every((c, i) => bytes[offset + i] === c.charCodeAt(0));
const u32le = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
const u32be = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;

function isAudioOgg(bytes) {
  let offset = 0;
  let streams = 0;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || !ascii(bytes, offset, 'OggS') || bytes[offset + 4] !== 0) return false;
    const count = bytes[offset + 26];
    const start = offset + 27 + count;
    if (start > bytes.length) return false;
    let length = 0;
    for (let i = offset + 27; i < start; i++) length += bytes[i];
    if (start + length > bytes.length) return false;
    if (bytes[offset + 5] & 2) {
      // Each logical stream must be a known audio codec, never Theora/video.
      if (!(ascii(bytes, start, 'OpusHead') || (bytes[start] === 1 && ascii(bytes, start + 1, 'vorbis')) || (bytes[start] === 0x7f && ascii(bytes, start + 1, 'FLAC')))) return false;
      streams++;
    }
    offset = start + length;
  }
  return streams > 0;
}

function mp3HeaderAt(bytes, offset) {
  return offset + 4 <= bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0
    && (bytes[offset + 1] & 0x18) !== 0x08 && (bytes[offset + 1] & 0x06) !== 0
    && (bytes[offset + 2] & 0xf0) !== 0 && (bytes[offset + 2] & 0xf0) !== 0xf0
    && (bytes[offset + 2] & 0x0c) !== 0x0c;
}

export function inspectMediaBytes(input, declaredMime = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) throw new MediaError('Empty files are not supported.');
  if (bytes.length > MAX_AUDIO_BYTES) throw new MediaError('Audio file size must be 10MB or less; images must be 5MB or less.', 413);
  let extension;
  if (bytes.length >= 45 && ascii(bytes, 0, '\x89PNG\r\n\x1a\n') && u32be(bytes, 8) === 13 && ascii(bytes, 12, 'IHDR')
      && u32be(bytes, 16) > 0 && u32be(bytes, 20) > 0 && ascii(bytes, bytes.length - 8, 'IEND')) extension = 'png';
  else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) extension = 'jpg';
  else if (bytes.length >= 14 && (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))
      && (bytes[6] || bytes[7]) && (bytes[8] || bytes[9]) && bytes[bytes.length - 1] === 0x3b) extension = 'gif';
  else if (bytes.length >= 20 && ascii(bytes, 0, 'RIFF') && u32le(bytes, 4) + 8 === bytes.length && ascii(bytes, 8, 'WEBP')
      && ['VP8 ', 'VP8L', 'VP8X'].some((kind) => ascii(bytes, 12, kind))) extension = 'webp';
  else if (bytes.length >= 44 && ascii(bytes, 0, 'RIFF') && u32le(bytes, 4) + 8 === bytes.length && ascii(bytes, 8, 'WAVE')) {
    let hasFormat = false;
    let hasData = false;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = u32le(bytes, offset + 4);
      if (offset + 8 + length > bytes.length) break;
      if (ascii(bytes, offset, 'fmt ') && length >= 16) hasFormat = true;
      if (ascii(bytes, offset, 'data') && length > 0) hasData = true;
      offset += 8 + length + (length % 2);
    }
    if (hasFormat && hasData) extension = 'wav';
  } else if (bytes.length >= 42 && ascii(bytes, 0, 'fLaC') && (bytes[4] & 0x7f) === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 34) extension = 'flac';
  else if (ascii(bytes, 0, 'OggS') && isAudioOgg(bytes)) extension = 'ogg';
  else {
    let offset = 0;
    if (bytes.length >= 10 && ascii(bytes, 0, 'ID3')) {
      if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((b) => b & 0x80)) throw new MediaError('Invalid MP3 metadata header.');
      offset = 10 + (bytes[6] << 21 | bytes[7] << 14 | bytes[8] << 7 | bytes[9]);
      if (bytes[5] & 0x10) offset += 10;
    }
    if (mp3HeaderAt(bytes, offset)) extension = 'mp3';
  }
  if (!extension) throw new MediaError('Unsupported or invalid file content. Use PNG, JPEG, GIF, WebP, MP3, WAV, Ogg audio, or FLAC. SVG, HTML, and video are not supported.');
  const mime = TYPES[extension];
  const type = mime.startsWith('image/') ? 'image' : 'audio';
  if (type === 'image' && bytes.length > MAX_IMAGE_BYTES) throw new MediaError('Image file size must be 5MB or less.', 413);
  const declared = String(declaredMime).toLowerCase().split(';')[0].trim();
  if (declared && declared !== 'application/octet-stream' && (MIME_ALIASES[declared] || declared) !== mime) {
    throw new MediaError('The file content does not match its declared media type.');
  }
  return { mime, type, extension, size: bytes.length };
}

export function newMediaFilename(extension) {
  if (!TYPES[extension]) throw new MediaError('Unsupported media extension.');
  return `${crypto.randomUUID().replaceAll('-', '')}.${extension}`;
}
export function isMediaFilename(filename) { return /^[a-f0-9]{32}\.(?:png|jpg|gif|webp|mp3|wav|ogg|flac)$/.test(filename); }
export function isLegacyFilename(filename) { return /^\d{10,16}-[a-f0-9]{12}\.(?:png|jpe?g|gif|webp|mp3|wav|ogg|flac)$/i.test(filename); }
export function mediaHeaders(mime, filename) {
  return {
    'Content-Type': mime,
    'Content-Disposition': `inline; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, max-age=3600',
    'Accept-Ranges': 'bytes',
  };
}
export function parseMediaRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || [match[1], match[2]].some((part) => part && !Number.isSafeInteger(Number(part)))) throw new MediaError('Requested media range is not satisfiable.', 416);
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) throw new MediaError('Requested media range is not satisfiable.', 416);
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}

export function objectMediaStore(bucket) {
  if (!bucket?.put || !bucket?.get || !bucket?.head) throw new MediaError('Hosted media storage is not configured. Bind an R2 bucket as MEDIA_BUCKET before uploading files.', 503);
  return {
    async put(bytes, info) {
      const filename = newMediaFilename(info.extension);
      await bucket.put(`${OBJECT_PREFIX}${filename}`, bytes, {
        httpMetadata: { contentType: info.mime },
        customMetadata: { mediaType: info.type, createdAt: new Date().toISOString() },
        onlyIf: { etagDoesNotMatch: '*' },
      }).then((result) => { if (!result) throw new MediaError('Media could not be stored. Please try again.', 503); });
      return { ...info, filename, url: `${MEDIA_PREFIX}${filename}` };
    },
    async head(filename) { return isMediaFilename(filename) ? bucket.head(`${OBJECT_PREFIX}${filename}`) : null; },
    async get(filename, range) { return isMediaFilename(filename) ? bucket.get(`${OBJECT_PREFIX}${filename}`, range ? { range } : undefined) : null; },
  };
}

// Bound the multipart body even when Content-Length is missing or dishonest.
export async function readMediaForm(request) {
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_UPLOAD_BODY_BYTES) throw new MediaError('Media upload is too large (10MB maximum).', 413);
  if (!request.body) throw new MediaError('Choose a file to upload.');
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BODY_BYTES) { await reader.cancel(); throw new MediaError('Media upload is too large (10MB maximum).', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let form;
  try { form = await new Response(body, { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData(); }
  catch { throw new MediaError('Choose a file in a valid multipart upload.'); }
  const files = form.getAll('file');
  if (files.length !== 1 || typeof files[0]?.arrayBuffer !== 'function') throw new MediaError('Choose exactly one image or audio file to upload.');
  return files[0];
}

export function questionMediaItems(row) {
  const items = [];
  if (row.media !== null && row.media !== undefined && row.media !== '' && row.media !== 'null') {
    items.push({ label: 'question media', value: typeof row.media === 'string' ? JSON.parse(row.media) : row.media });
  }
  const config = typeof row.question_config === 'string' ? JSON.parse(row.question_config || '{}') : row.question_config;
  if (config?.stimulus?.media) items.push({ label: 'stimulus media', value: config.stimulus.media });
  return items;
}

export function mediaPublishProblem(row) {
  let items;
  try { items = questionMediaItems(row); } catch { return `Question #${row.id} has malformed media or question configuration.`; }
  for (const { label, value } of items) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !['image', 'audio'].includes(value.type)) return `Question #${row.id} has invalid ${label}.`;
    if (value.placeholder || value.pending || value.is_placeholder || ['pending', '[placeholder]'].includes(value.url)) return `Question #${row.id} has an unresolved media placeholder. Please attach media before publishing.`;
    if (typeof value.url !== 'string' || !value.url.trim()) return `Question #${row.id} has missing ${label}.`;
    const url = value.url;
    if (/[\\\u0000-\u0020]/.test(url)) return `Question #${row.id} has an unsafe ${label} URL.`;
    if (url.startsWith('data:')) {
      // Legacy inline uploads remain readable and can be published, but only
      // safe raster/audio types with matching bytes; new uploads never use D1.
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
      if (!match || url.length > MAX_UPLOAD_BODY_BYTES * 1.4) return `Question #${row.id} has invalid inline ${label}.`;
      try {
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        if (inspectMediaBytes(bytes, match[1]).type !== value.type) return `Question #${row.id} has mismatched ${label}.`;
      } catch { return `Question #${row.id} has unsafe or invalid inline ${label}.`; }
    } else if (!(url.startsWith('/') && !/^[/\\]{2}/.test(url) && !/[\\\u0000-\u0020]/.test(url))) {
      try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); }
      catch { return `Question #${row.id} has an unsafe ${label} URL.`; }
    }
  }
  return null;
}

export function backupMediaManifest(rows, storage) {
  const urls = new Set();
  let inlineCount = 0;
  for (const row of rows) {
    try {
      for (const { value } of questionMediaItems(row)) {
        if (value?.url?.startsWith('data:')) inlineCount++;
        else if (value?.url && !value.placeholder) urls.add(value.url);
      }
    } catch { /* Invalid stored rows remain in the database export for repair. */ }
  }
  return { storage, files_included: false, referenced_urls: [...urls].sort(), legacy_inline_count: inlineCount,
    restore_note: 'Back up and restore the media directory or MEDIA_BUCKET separately, preserving object keys. Include every archived question version. Database JSON alone is not a complete media backup.' };
}
