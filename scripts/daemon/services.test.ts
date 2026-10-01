import { expect, test } from 'bun:test';
import { localServices } from './services';

test('starts only the services the environment points at on this machine', () => {
  expect(
    localServices({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5442/foundry',
      REDIS_URL: 'redis://127.0.0.1:6389',
      MUNINN_URL: 'https://muninn.example.com',
    }),
  ).toEqual(['postgres', 'redis']);
  expect(localServices({})).toEqual([]);
  expect(localServices({ DATABASE_URL: 'not a url' })).toEqual([]);
});
