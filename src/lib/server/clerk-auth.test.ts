import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { clerkSessionMatchesUser, exchangeClerkSession, isClerkMode } from './clerk-auth';

type Call = { sql: string; args: unknown[] };

/** Records statements; `existing` is what the lookups by subject / email return. */
function mockDb(
	options: { bySubject?: object | null; byEmail?: object | null; clerkRow?: { id: string } | null } = {}
) {
	const calls: Call[] = [];
	const row = { id: 'u1', email: 'a@example.com', name: 'Ada', is_admin: 1, must_change_password: 0, created_at: 't' };
	let inserted = false;

	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					calls.push({ sql, args });
					return {
						async first() {
							if (sql.includes("auth_provider = 'clerk'")) return options.clerkRow ?? null;
							if (sql.includes('auth_provider = ?')) {
								return inserted ? row : (options.bySubject ?? null);
							}
							if (sql.includes('WHERE email = ?')) return options.byEmail ?? null;
							return null;
						},
						async run() {
							if (sql.startsWith('INSERT INTO users')) inserted = true;
							return { meta: { changes: 1 } };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	return { db, calls };
}

async function signToken(claims: Record<string, unknown>) {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	const b64 = (input: ArrayBuffer | string) =>
		Buffer.from(typeof input === 'string' ? input : new Uint8Array(input)).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	const signingInput = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' }))}.${b64(
		JSON.stringify({ iss: 'https://clerk.example.com', iat: now, nbf: now - 5, exp: now + 60, ...claims })
	)}`;
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signingInput));
	const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
	const pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
	return { token: `${signingInput}.${b64(signature)}`, pem };
}

describe('isClerkMode', () => {
	test('only the explicit value opts in', () => {
		assert.equal(isClerkMode(undefined), false);
		assert.equal(isClerkMode({}), false);
		assert.equal(isClerkMode({ AUTH_MODE: 'password' }), false);
		assert.equal(isClerkMode({ AUTH_MODE: 'clerk' }), true);
	});
});

describe('exchangeClerkSession', () => {
	test('a valid token creates the user and a local session', async () => {
		const { token, pem } = await signToken({ sub: 'user_1', email: 'A@Example.com', name: 'Ada' });
		const { db, calls } = mockDb();

		const result = await exchangeClerkSession(db, { CLERK_JWT_KEY: pem }, token);

		assert.ok(result);
		assert.equal(result.user.email, 'a@example.com');
		const insert = calls.find((call) => call.sql.startsWith('INSERT INTO users'));
		assert.deepEqual(insert?.args.slice(1, 4), ['a@example.com', 'Ada', '!']);
		assert.deepEqual(insert?.args.slice(-2), ['clerk', 'user_1']);
		assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO sessions')));
	});

	test('a token signed by another key is rejected without touching the database', async () => {
		const { token } = await signToken({ sub: 'user_1', email: 'a@example.com' });
		const { pem } = await signToken({ sub: 'x', email: 'x@example.com' });
		const { db, calls } = mockDb();

		assert.equal(await exchangeClerkSession(db, { CLERK_JWT_KEY: pem }, token), null);
		assert.equal(calls.length, 0);
	});

	test('a token without an email claim is rejected', async () => {
		const { token, pem } = await signToken({ sub: 'user_1' });
		const { db, calls } = mockDb();

		assert.equal(await exchangeClerkSession(db, { CLERK_JWT_KEY: pem }, token), null);
		assert.equal(calls.length, 0);
	});

	test('an unrelated local account with the same email is not adopted', async () => {
		const { token, pem } = await signToken({ sub: 'user_1', email: 'a@example.com' });
		const { db, calls } = mockDb({ byEmail: { id: 'local', email: 'a@example.com', password_hash: 'x' } });

		assert.equal(await exchangeClerkSession(db, { CLERK_JWT_KEY: pem }, token), null);
		assert.ok(!calls.some((call) => call.sql.startsWith('INSERT')));
	});

	test('a known subject reuses its user and only mints a session', async () => {
		const { token, pem } = await signToken({ sub: 'user_1', email: 'a@example.com' });
		const known = { id: 'u9', email: 'a@example.com', name: 'Ada', is_admin: 0, must_change_password: 0, created_at: 't' };
		const { db, calls } = mockDb({ bySubject: known });

		const result = await exchangeClerkSession(db, { CLERK_JWT_KEY: pem }, token);

		assert.equal(result?.user.id, 'u9');
		assert.ok(!calls.some((call) => call.sql.startsWith('INSERT INTO users')));
		assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO sessions')));
	});

	test('allowlisted emails are flagged admin on insert', async () => {
		const { token, pem } = await signToken({ sub: 'user_1', email: 'a@example.com' });
		const { db, calls } = mockDb();

		await exchangeClerkSession(db, { CLERK_JWT_KEY: pem, ADMIN_EMAILS: 'x@y.com, A@example.com' }, token);

		const insert = calls.find((call) => call.sql.startsWith('INSERT INTO users'));
		assert.equal(insert?.args[4], 1);
	});
});

describe('clerkSessionMatchesUser', () => {
	test('the same person matches', async () => {
		const { token, pem } = await signToken({ sub: 'user_1', email: 'a@example.com' });
		const { db } = mockDb({ clerkRow: { id: 'u1' } });
		assert.equal(await clerkSessionMatchesUser(db, { CLERK_JWT_KEY: pem }, token, 'u1'), true);
	});

	test('a different Clerk user does not', async () => {
		const { token, pem } = await signToken({ sub: 'user_2', email: 'b@example.com' });
		const { db } = mockDb({ clerkRow: { id: 'u2' } });
		assert.equal(await clerkSessionMatchesUser(db, { CLERK_JWT_KEY: pem }, token, 'u1'), false);
	});

	test('a Clerk user with no local account yet does not match', async () => {
		const { token, pem } = await signToken({ sub: 'user_3', email: 'c@example.com' });
		const { db } = mockDb({ clerkRow: null });
		assert.equal(await clerkSessionMatchesUser(db, { CLERK_JWT_KEY: pem }, token, 'u1'), false);
	});

	test('an unverifiable token gives no opinion', async () => {
		const { token } = await signToken({ sub: 'user_1' });
		const { pem } = await signToken({ sub: 'x' });
		const { db, calls } = mockDb();
		assert.equal(await clerkSessionMatchesUser(db, { CLERK_JWT_KEY: pem }, token, 'u1'), true);
		assert.equal(calls.length, 0);
	});
});
