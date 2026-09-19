import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { handleClerkWebhook } from './clerk-webhook';

type Call = { sql: string; args: unknown[] };

/** `linkedUserId` is what the lookup by Clerk subject returns. */
function mockDb(linkedUserId: string | null) {
	const calls: Call[] = [];
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						sql,
						args,
						async first() {
							return sql.includes('SELECT id FROM users') && linkedUserId ? { id: linkedUserId } : null;
						},
						async run() {
							calls.push({ sql, args });
							return { meta: { changes: 1 } };
						}
					};
				}
			};
		},
		async batch(statements: Call[]) {
			calls.push(...statements.map(({ sql, args }) => ({ sql, args })));
			return statements.map(() => ({ meta: { changes: 1 } }));
		}
	} as unknown as D1Database;
	return { db, calls };
}

describe('handleClerkWebhook', () => {
	test('user.deleted revokes every credential and keeps the account and mail', async () => {
		const { db, calls } = mockDb('local-1');

		assert.equal(await handleClerkWebhook(db, { type: 'user.deleted', data: { id: 'user_1' } }), 'revoked');

		const tables = calls.map((call) => /DELETE FROM (\w+)/.exec(call.sql)?.[1]);
		assert.deepEqual(tables.sort(), [
			'api_tokens',
			'oauth_codes',
			'oauth_grants',
			'pairing_codes',
			'push_subscriptions',
			'sessions'
		]);
		assert.ok(calls.every((call) => call.args[0] === 'local-1'));
		assert.ok(!calls.some((call) => /FROM (users|emails|addresses)\b/.test(call.sql) && call.sql.startsWith('DELETE')));
	});

	test('a subject with no local account changes nothing', async () => {
		const { db, calls } = mockDb(null);
		assert.equal(await handleClerkWebhook(db, { type: 'user.deleted', data: { id: 'user_x' } }), 'unknown_user');
		assert.equal(calls.length, 0);
	});

	test('user.updated syncs the name and the primary email only', async () => {
		const { db, calls } = mockDb('local-1');

		const outcome = await handleClerkWebhook(db, {
			type: 'user.updated',
			data: {
				id: 'user_1',
				first_name: 'Ada',
				last_name: 'Lovelace',
				primary_email_address_id: 'idn_2',
				email_addresses: [
					{ id: 'idn_1', email_address: 'old@example.com' },
					{ id: 'idn_2', email_address: 'New@Example.com' }
				]
			}
		});

		assert.equal(outcome, 'synced');
		const name = calls.find((call) => call.sql.startsWith('UPDATE users SET name'));
		assert.deepEqual(name?.args.slice(0, 3), ['Ada Lovelace', 'clerk', 'user_1']);
		const email = calls.find((call) => call.sql.includes('SET email'));
		assert.equal(email?.args[0], 'new@example.com');
	});

	test('events that are not user.updated or user.deleted are ignored', async () => {
		const { db, calls } = mockDb('local-1');
		assert.equal(await handleClerkWebhook(db, { type: 'user.created', data: { id: 'user_1' } }), 'ignored');
		assert.equal(await handleClerkWebhook(db, { type: 'user.deleted', data: {} }), 'ignored');
		assert.equal(calls.length, 0);
	});
});
