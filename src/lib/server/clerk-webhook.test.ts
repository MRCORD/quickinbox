import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { handleClerkWebhook } from './clerk-webhook';

type Call = { sql: string; args: unknown[] };

/**
 * `linkedUserId` is what the lookup by Clerk subject returns; `identity` says
 * what their login email is and whether it is one of their own mailboxes.
 */
function mockDb(
	linkedUserId: string | null,
	identity: { email: string; org: boolean } = { email: 'personal@example.com', org: false }
) {
	const calls: Call[] = [];
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						sql,
						args,
						async first() {
							return sql.includes('SELECT u.id, u.email') && linkedUserId
								? { id: linkedUserId, email: identity.email, org: identity.org ? 1 : 0 }
								: null;
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

describe('holding the org address as primary', () => {
	const ORG = 'ada@org.example';
	const fromClerk = (primaryId: string, ids: Record<string, string>) => ({
		type: 'user.updated',
		data: {
			id: 'user_1',
			first_name: 'Ada',
			last_name: 'Lovelace',
			primary_email_address_id: primaryId,
			email_addresses: Object.entries(ids).map(([id, email_address]) => ({ id, email_address }))
		}
	});
	const recorder = (status = 200) => {
		const sent: { url: string; method: string; body: unknown }[] = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			sent.push({ url, method: init.method ?? 'GET', body: JSON.parse(init.body as string) });
			return new Response('{}', { status });
		}) as unknown as typeof fetch;
		return { sent, fetcher };
	};
	const env = { CLERK_SECRET_KEY: 'sk_x' };

	test('moving the primary away re-points it at the org address still on the account', async () => {
		const { db, calls } = mockDb('local-1', { email: ORG, org: true });
		const { sent, fetcher } = recorder();

		const outcome = await handleClerkWebhook(
			db,
			fromClerk('idn_p', { idn_o: ORG, idn_p: 'personal@example.com' }),
			env,
			fetcher
		);

		assert.equal(outcome, 'enforced');
		assert.equal(sent.length, 1);
		assert.equal(sent[0].method, 'PATCH');
		assert.equal(sent[0].url, 'https://api.clerk.com/v1/users/user_1');
		assert.deepEqual(sent[0].body, { primary_email_address_id: 'idn_o' });
		// The change is not copied into the app.
		assert.ok(!calls.some((call) => call.sql.includes('SET email')));
	});

	test('if they deleted the org address it is added back as verified and primary', async () => {
		const { db } = mockDb('local-1', { email: ORG, org: true });
		const { sent, fetcher } = recorder();

		const outcome = await handleClerkWebhook(db, fromClerk('idn_p', { idn_p: 'personal@example.com' }), env, fetcher);

		assert.equal(outcome, 'enforced');
		assert.equal(sent[0].url, 'https://api.clerk.com/v1/email_addresses');
		assert.deepEqual(sent[0].body, { user_id: 'user_1', email_address: ORG, verified: true, primary: true });
	});

	test('when the org address is still primary nothing is sent to Clerk', async () => {
		const { db } = mockDb('local-1', { email: ORG, org: true });
		const { sent, fetcher } = recorder();

		const outcome = await handleClerkWebhook(
			db,
			fromClerk('idn_o', { idn_o: 'ADA@org.example', idn_p: 'personal@example.com' }),
			env,
			fetcher
		);

		assert.equal(outcome, 'synced');
		assert.equal(sent.length, 0);
	});

	test('someone whose login is not one of their mailboxes has email changes mirrored', async () => {
		const { db, calls } = mockDb('local-1', { email: 'old@example.com', org: false });
		const { sent, fetcher } = recorder();

		const outcome = await handleClerkWebhook(
			db,
			fromClerk('idn_n', { idn_n: 'new@example.com' }),
			env,
			fetcher
		);

		assert.equal(outcome, 'synced');
		assert.equal(sent.length, 0);
		assert.ok(calls.some((call) => call.sql.includes('SET email') && call.args[0] === 'new@example.com'));
	});

	test('a name change still syncs for an org identity', async () => {
		const { db, calls } = mockDb('local-1', { email: ORG, org: true });
		await handleClerkWebhook(db, fromClerk('idn_o', { idn_o: ORG }), env, recorder().fetcher);
		assert.ok(calls.some((call) => call.sql.startsWith('UPDATE users SET name') && call.args[0] === 'Ada Lovelace'));
	});

	test('when Clerk refuses, or there is no key, it reports enforce_failed and does not throw', async () => {
		const primaryElsewhere = fromClerk('idn_p', { idn_o: ORG, idn_p: 'personal@example.com' });

		const refused = recorder(422);
		assert.equal(
			await handleClerkWebhook(mockDb('local-1', { email: ORG, org: true }).db, primaryElsewhere, env, refused.fetcher),
			'enforce_failed'
		);
		assert.equal(
			await handleClerkWebhook(mockDb('local-1', { email: ORG, org: true }).db, primaryElsewhere, {}, recorder().fetcher),
			'enforce_failed'
		);
	});
});

