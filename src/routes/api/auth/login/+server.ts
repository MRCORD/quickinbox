import { json, type RequestHandler } from '@sveltejs/kit';
import { login, logout, readSessionToken, sessionCookieOptions, SESSION_COOKIE } from '$lib/server/auth';
import { isClerkMode } from '$lib/server/clerk-auth';
import { readLinkedTokens, resolveLinkedSessions, writeLinkedTokens } from '$lib/server/accounts';
import { LINKED_SESSIONS_COOKIE, MAX_LINKED_ACCOUNTS, SESSION_DAYS } from '$lib/server/constants';

export const POST: RequestHandler = async ({ request, cookies, platform, url }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });
	if (isClerkMode(platform?.env)) {
		return json({ error: 'Password sign-in is disabled when AUTH_MODE=clerk' }, { status: 403 });
	}

	const body = (await request.json()) as { email?: string; password?: string; add?: boolean };
	if (!body.email || !body.password) {
		return json({ error: 'Email and password are required' }, { status: 400 });
	}

	// `add` keeps the accounts already signed in on this browser and parks them
	// behind the new one. A plain login replaces the active session as before.
	const activeToken = readSessionToken(cookies);
	const existing = body.add === true
		? await resolveLinkedSessions(db, [activeToken ?? '', ...readLinkedTokens(cookies)])
		: [];

	if (body.add === true && existing.length >= MAX_LINKED_ACCOUNTS) {
		// Only refuse when the new login would not simply replace one of them.
		const sameUser = existing.some((session) => session.user.email === body.email!.toLowerCase().trim());
		if (!sameUser) {
			return json(
				{ error: `You can be signed in to at most ${MAX_LINKED_ACCOUNTS} accounts. Log out of one first.` },
				{ status: 400 }
			);
		}
	}

	const result = await login(db, body.email, body.password);
	if (!result) {
		return json({ error: 'Invalid email or password' }, { status: 401 });
	}

	// Signing in again as an account that is already here replaces its old
	// session rather than leaving an orphan row behind.
	const replaced = existing.filter((session) => session.user.id === result.user.id);
	await Promise.all(replaced.map((session) => logout(db, session.token)));
	const parked = existing.filter((session) => session.user.id !== result.user.id);

	cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60, url));
	if (body.add === true) {
		writeLinkedTokens(cookies, parked.map((session) => session.token), url);
	}

	return json({ user: result.user, accounts: parked.length + 1 });
};

/**
 * Log out. By default only the active account goes; if other accounts are
 * signed in on this browser the first of them becomes active and the client is
 * told to stay in the mailbox. `?all=1` ends every session and clears both cookies.
 */
export const DELETE: RequestHandler = async ({ cookies, platform, url }) => {
	// Ending only the local session would let the still-valid Clerk session sign
	// the person straight back in, so the client is told to end that one too.
	const signedOut = () =>
		json({
			ok: true,
			next: '/login',
			...(isClerkMode(platform?.env)
				? { clerkPublishableKey: platform?.env.CLERK_PUBLISHABLE_KEY ?? null }
				: {})
		});

	const db = platform?.env.DB;
	const activeToken = readSessionToken(cookies);
	const linked = readLinkedTokens(cookies).filter((token) => token !== activeToken);
	const everything = url.searchParams.get('all') === '1';

	if (db && activeToken) {
		await logout(db, activeToken);
	}

	if (everything) {
		if (db) await Promise.all(linked.map((token) => logout(db, token)));
		cookies.delete(SESSION_COOKIE, { path: '/' });
		cookies.delete(LINKED_SESSIONS_COOKIE, { path: '/' });
		return signedOut();
	}

	const remaining = db ? await resolveLinkedSessions(db, linked) : [];
	const next = remaining.shift();
	if (!next) {
		cookies.delete(SESSION_COOKIE, { path: '/' });
		cookies.delete(LINKED_SESSIONS_COOKIE, { path: '/' });
		return signedOut();
	}

	cookies.set(SESSION_COOKIE, next.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60, url));
	writeLinkedTokens(cookies, remaining.map((session) => session.token), url);
	return json({
		ok: true,
		next: next.user.must_change_password ? '/account/setup' : '/inbox',
		user: next.user
	});
};
