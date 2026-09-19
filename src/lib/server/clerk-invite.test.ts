import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { makeClerkEmailPrimary, sendClerkInvitation } from './clerk-invite';

type Sent = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
	const sent: Sent[] = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		sent.push({ url, init });
		return respond();
	}) as unknown as typeof fetch;
	return { fetcher, sent };
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sendClerkInvitation', () => {
	test('posts the invitation to Clerk with the secret and redirect', async () => {
		const { fetcher, sent } = fakeFetch(() => json(200, { id: 'inv_1' }));

		const outcome = await sendClerkInvitation(
			{ CLERK_SECRET_KEY: 'sk_test_x' },
			'new@example.com',
			'https://mail.example.com/login',
			fetcher
		);

		assert.equal(outcome, 'sent');
		assert.equal(sent[0].url, 'https://api.clerk.com/v1/invitations');
		assert.equal((sent[0].init.headers as Record<string, string>).Authorization, 'Bearer sk_test_x');
		assert.deepEqual(JSON.parse(sent[0].init.body as string), {
			email_address: 'new@example.com',
			redirect_url: 'https://mail.example.com/login',
			notify: true
		});
	});

	test('without a secret key nothing is sent', async () => {
		const { fetcher, sent } = fakeFetch(() => json(200, {}));
		assert.equal(await sendClerkInvitation({}, 'a@example.com', 'https://x/login', fetcher), 'skipped');
		assert.equal(sent.length, 0);
	});

	test('an existing invitation or Clerk account counts as fine', async () => {
		for (const code of ['duplicate_record', 'form_identifier_exists']) {
			const { fetcher } = fakeFetch(() => json(422, { errors: [{ code }] }));
			assert.equal(
				await sendClerkInvitation({ CLERK_SECRET_KEY: 'sk' }, 'a@example.com', 'https://x/login', fetcher),
				'exists'
			);
		}
	});

	test('other errors and network failures report failed instead of throwing', async () => {
		const bad = fakeFetch(() => json(401, { errors: [{ code: 'authentication_invalid' }] }));
		assert.equal(
			await sendClerkInvitation({ CLERK_SECRET_KEY: 'sk' }, 'a@example.com', 'https://x/login', bad.fetcher),
			'failed'
		);
		const down = fakeFetch(() => Promise.reject(new Error('network down')));
		assert.equal(
			await sendClerkInvitation({ CLERK_SECRET_KEY: 'sk' }, 'a@example.com', 'https://x/login', down.fetcher),
			'failed'
		);
	});
});

describe('makeClerkEmailPrimary', () => {
	test('adds the address as verified and primary', async () => {
		const { fetcher, sent } = fakeFetch(() => json(200, {}));
		assert.equal(await makeClerkEmailPrimary({ CLERK_SECRET_KEY: 'sk' }, 'user_1', 'ada@org.com', fetcher), true);
		assert.deepEqual(JSON.parse(sent[0].init.body as string), {
			user_id: 'user_1',
			email_address: 'ada@org.com',
			verified: true,
			primary: true
		});
	});

	test('without a key, or when Clerk refuses, it reports false and does not throw', async () => {
		const none = fakeFetch(() => json(200, {}));
		assert.equal(await makeClerkEmailPrimary({}, 'user_1', 'a@b.co', none.fetcher), false);
		assert.equal(none.sent.length, 0);
		const refused = fakeFetch(() => json(422, { errors: [{ code: 'form_identifier_exists' }] }));
		assert.equal(await makeClerkEmailPrimary({ CLERK_SECRET_KEY: 'sk' }, 'user_1', 'a@b.co', refused.fetcher), false);
	});
});
