import { expect, test } from 'bun:test';
import { kingdomOwnerOf } from '../src/viewer/ui/kingdom-holder.js';

const status = {
  integrations: [
    {
      id: 'k-acme',
      url: 'https://kingdom.example',
      holder: { owner: { organization: { name: 'Acme' } } },
    },
    { id: 'k-me', url: 'https://other.example', holder: { owner: { user: { name: 'You' } } } },
  ],
};

// The header names the Kingdom owner only for a project that runs on a Kingdom pool, matched by the
// paired Kingdom's id, or by origin when exactly one pairing has it.
test('kingdomOwnerOf names the owner of a Kingdom-pool project and nothing else', () => {
  const config = {
    projects: {
      shop: { capacity: 'kingdom', kingdomCapacity: { kingdom: 'k-acme', signetId: 's' } },
      site: {
        capacity: 'kingdom',
        kingdomCapacity: { kingdom: 'https://other.example/', signetId: 's' },
      },
      local: { capacity: 'local' },
      gone: { capacity: 'kingdom', kingdomCapacity: { kingdom: 'k-missing', signetId: 's' } },
    },
  };
  expect(kingdomOwnerOf(config, status, 'shop')).toBe('Acme');
  expect(kingdomOwnerOf(config, status, 'site')).toBe('You');
  expect(kingdomOwnerOf(config, status, 'local')).toBeNull();
  expect(kingdomOwnerOf(config, status, 'gone')).toBeNull();
  expect(kingdomOwnerOf(config, null, 'shop')).toBeNull();
});
