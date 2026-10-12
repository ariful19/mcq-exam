import test from 'node:test';
import assert from 'node:assert/strict';
import { shortenWithIsgd, isPrivateUrl } from '../server/isgd.js';

test('isPrivateUrl identifies loopback and private hosts', () => {
  assert.equal(isPrivateUrl('http://localhost:3000/exam/1'), true);
  assert.equal(isPrivateUrl('http://127.0.0.1:3000/exam/1'), true);
  assert.equal(isPrivateUrl('http://192.168.1.5:8080/exam/1'), true);
  assert.equal(isPrivateUrl('https://portal.example.com/exam/1'), false);
  assert.equal(isPrivateUrl('https://mcq-exams.edu/exam/1'), false);
});

test('shortenWithIsgd validates long URL parameter', async () => {
  await assert.rejects(
    () => shortenWithIsgd(''),
    (err) => err.code === 1 && err.message.includes('specify a URL')
  );

  await assert.rejects(
    () => shortenWithIsgd('ftp://example.com/test'),
    (err) => err.code === 1 && err.message.includes('http:// or https://')
  );

  await assert.rejects(
    () => shortenWithIsgd('http://localhost:3000/exam/1'),
    (err) => err.code === 1 && err.message.includes('publicly accessible URL')
  );
});

test('shortenWithIsgd validates custom shorturl format', async () => {
  await assert.rejects(
    () => shortenWithIsgd('https://example.com/exam/1', { shorturl: 'bad!' }),
    (err) => err.code === 2 && err.message.includes('5 to 30')
  );

  await assert.rejects(
    () => shortenWithIsgd('https://example.com/exam/1', { shorturl: 'tiny' }),
    (err) => err.code === 2 && err.message.includes('5 to 30')
  );
});

test('shortenWithIsgd makes proper API request and returns short URL', async () => {
  let requestedUrl = '';
  let requestedHeaders = {};

  const mockFetch = async (url, options) => {
    requestedUrl = url;
    requestedHeaders = options?.headers || {};
    return {
      status: 200,
      text: async () => JSON.stringify({ shorturl: 'https://is.gd/abc123' }),
    };
  };

  const result = await shortenWithIsgd('https://example.com/exam/42?mode=full', {
    shorturl: 'my_exam_42',
    logstats: true,
    fetchFn: mockFetch,
  });

  assert.equal(result.shorturl, 'https://is.gd/abc123');
  assert.ok(requestedUrl.startsWith('https://is.gd/create.php?'));
  const urlObj = new URL(requestedUrl);
  assert.equal(urlObj.searchParams.get('format'), 'json');
  assert.equal(urlObj.searchParams.get('url'), 'https://example.com/exam/42?mode=full');
  assert.equal(urlObj.searchParams.get('shorturl'), 'my_exam_42');
  assert.equal(urlObj.searchParams.get('logstats'), '1');
  assert.ok(requestedHeaders['User-Agent'].includes('MCQ-Exam-Portal'));
});

test('shortenWithIsgd parses is.gd error responses correctly', async () => {
  const mockFetch = async () => ({
    status: 406,
    text: async () => JSON.stringify({ errorcode: 2, errormessage: 'The shortened URL you picked is already in use.' }),
  });

  await assert.rejects(
    () => shortenWithIsgd('https://example.com/exam/1', { shorturl: 'taken123', fetchFn: mockFetch }),
    (err) => err.code === 2 && err.message.includes('already in use')
  );
});

test('shortenWithIsgd handles non-JSON service errors safely', async () => {
  const mockFetch = async () => ({
    status: 502,
    text: async () => 'Error, database insert failed',
  });

  await assert.rejects(
    () => shortenWithIsgd('https://example.com/exam/1', { fetchFn: mockFetch }),
    (err) => err.message.includes('Error, database insert failed')
  );
});
