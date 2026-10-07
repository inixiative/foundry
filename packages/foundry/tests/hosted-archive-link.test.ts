import { expect, test } from 'bun:test';
import { hostedSetupUrl } from '../src/viewer/ui/hosted-archive-link.js';

test('links an https or loopback Kingdom to its hosted Archive setup', () => {
  expect(hostedSetupUrl('https://kingdom-prod-api-prod.up.railway.app')).toBe(
    'https://kingdom-prod-api-prod.up.railway.app/dashboard?setupArchive=1',
  );
  expect(hostedSetupUrl('http://localhost:8200')).toBe(
    'http://localhost:8200/dashboard?setupArchive=1',
  );
  expect(hostedSetupUrl('http://127.0.0.1:8200/api')).toBe(
    'http://127.0.0.1:8200/dashboard?setupArchive=1',
  );
});

test('refuses any other origin', () => {
  expect(hostedSetupUrl('http://kingdom.example')).toBeNull();
  expect(hostedSetupUrl('javascript:alert(1)')).toBeNull();
  expect(hostedSetupUrl('not a url')).toBeNull();
});
