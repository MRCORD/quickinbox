import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { frontendApiHost } from './clerk-client';

describe('frontendApiHost', () => {
	test('decodes the host out of a publishable key', () => {
		const key = `pk_test_${btoa('happy-cat-1.clerk.accounts.dev$')}`;
		assert.equal(frontendApiHost(key), 'happy-cat-1.clerk.accounts.dev');
	});

	test('rejects keys that do not decode to a host', () => {
		assert.equal(frontendApiHost('pk_test'), null);
		assert.equal(frontendApiHost('pk_test_!!!'), null);
		assert.equal(frontendApiHost(`pk_test_${btoa('evil.com/x?y=1$')}`), null);
	});
});
