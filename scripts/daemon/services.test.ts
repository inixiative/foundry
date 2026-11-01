import { expect, test } from 'bun:test';
import { localServices } from './services';

test('starts only the services the environment points at on this machine', () => {
  expect(
    localServices({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5932/foundry',
      MUNINN_URL: 'https://muninn.example.com',
    }),
  ).toEqual(['postgres']);
  expect(localServices({})).toEqual([]);
  expect(localServices({ DATABASE_URL: 'not a url' })).toEqual([]);
});
