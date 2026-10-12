/**
 * is.gd URL Shortening API Client
 * Documentation Reference: https://is.gd/apishorteningreference.php
 */

const ISGD_API_URL = 'https://is.gd/create.php';

const PRIVATE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

/**
 * Checks whether a URL points to a local or private network address.
 * is.gd only shortens public internet addresses.
 */
export function isPrivateUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    if (PRIVATE_HOSTS.has(hostname)) return true;
    if (hostname.endsWith('.local') || hostname.endsWith('.localhost')) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Shortens a URL using is.gd API according to https://is.gd/apishorteningreference.php
 *
 * @param {string} url - The URL to shorten (must be http:// or https://)
 * @param {object} [options]
 * @param {string} [options.shorturl] - Optional custom short code (5-30 chars, alphanumeric + underscores)
 * @param {boolean|number} [options.logstats] - Optional detailed statistics logging
 * @param {typeof fetch} [options.fetchFn] - Optional fetch implementation for testing
 * @returns {Promise<{ shorturl: string }>}
 */
export async function shortenWithIsgd(url, options = {}) {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) {
    const error = new Error('Please specify a URL to shorten.');
    error.code = 1;
    throw error;
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    const error = new Error('URL must start with http:// or https://.');
    error.code = 1;
    throw error;
  }

  if (isPrivateUrl(targetUrl)) {
    const error = new Error('is.gd requires a publicly accessible URL (localhost / private network addresses cannot be shortened).');
    error.code = 1;
    throw error;
  }

  if (options.shorturl) {
    const shortCode = String(options.shorturl).trim();
    if (!/^[a-zA-Z0-9_]{5,30}$/.test(shortCode)) {
      const error = new Error('Custom short URL must be 5 to 30 alphanumeric characters or underscores.');
      error.code = 2;
      throw error;
    }
  }

  const queryParams = new URLSearchParams({
    format: 'json',
    url: targetUrl,
  });

  if (options.shorturl) {
    queryParams.set('shorturl', String(options.shorturl).trim());
  }
  if (options.logstats) {
    queryParams.set('logstats', '1');
  }

  const apiUrl = `${ISGD_API_URL}?${queryParams.toString()}`;
  const fetcher = options.fetchFn || globalThis.fetch;

  let response;
  try {
    response = await fetcher(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MCQ-Exam-Portal/1.0 (+https://is.gd/apishorteningreference.php)',
        'Accept': 'application/json, text/plain, */*',
      },
    });
  } catch (netErr) {
    const error = new Error(`Failed to contact is.gd service: ${netErr.message}`);
    error.code = 4;
    throw error;
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const error = new Error(text.trim() || `is.gd responded with HTTP status ${response.status}`);
    error.code = response.status === 502 ? 3 : 4;
    throw error;
  }

  if (data.errorcode) {
    const error = new Error(data.errormessage || 'Shortening failed.');
    error.code = data.errorcode;
    throw error;
  }

  if (!data.shorturl) {
    const error = new Error('Invalid response from is.gd: missing shorturl.');
    error.code = 4;
    throw error;
  }

  return { shorturl: data.shorturl };
}
