export type ClerkInviteOutcome = 'sent' | 'exists' | 'skipped' | 'failed';

/**
 * Ask Clerk to email an invitation. With sign-ups restricted at Clerk, a
 * person with no Clerk account cannot register without one, so inviting them
 * here has to invite them there too.
 *
 * Never throws: the local invite already exists by now, and a failed email
 * must not undo it. `exists` covers "already invited" and "already has a Clerk
 * account", where the person simply signs in.
 */
export async function sendClerkInvitation(
	env: { CLERK_SECRET_KEY?: string },
	email: string,
	redirectUrl: string,
	fetcher: typeof fetch = fetch
): Promise<ClerkInviteOutcome> {
	const secret = env.CLERK_SECRET_KEY?.trim();
	if (!secret) return 'skipped';

	try {
		const response = await fetcher('https://api.clerk.com/v1/invitations', {
			method: 'POST',
			headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ email_address: email, redirect_url: redirectUrl, notify: true }),
			signal: AbortSignal.timeout(8000)
		});
		if (response.ok) return 'sent';

		const body = (await response.json().catch(() => null)) as { errors?: { code?: string }[] } | null;
		const codes = (body?.errors ?? []).map((error) => error.code ?? 'unknown');
		if (codes.some((code) => code === 'duplicate_record' || code === 'form_identifier_exists')) {
			return 'exists';
		}
		console.error('Clerk invitation failed', response.status, codes.join(','));
		return 'failed';
	} catch (error) {
		console.error('Clerk invitation request failed', error instanceof Error ? error.message : error);
		return 'failed';
	}
}

/**
 * Add `email` to a Clerk user as their verified, primary address. Used when an
 * invited person claims their account: they were invited at a personal
 * address, and their org address (which an admin controls, hence "verified")
 * becomes primary. Their personal address stays as a secondary, so it still
 * works for recovery. Never throws; returns whether Clerk accepted it.
 */
export async function makeClerkEmailPrimary(
	env: { CLERK_SECRET_KEY?: string },
	clerkUserId: string,
	email: string,
	fetcher: typeof fetch = fetch
): Promise<boolean> {
	const secret = env.CLERK_SECRET_KEY?.trim();
	if (!secret) return false;

	try {
		const response = await fetcher('https://api.clerk.com/v1/email_addresses', {
			method: 'POST',
			headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ user_id: clerkUserId, email_address: email, verified: true, primary: true }),
			signal: AbortSignal.timeout(8000)
		});
		if (response.ok) return true;

		const body = (await response.json().catch(() => null)) as { errors?: { code?: string }[] } | null;
		console.warn(
			'Could not make the org address primary in Clerk',
			response.status,
			(body?.errors ?? []).map((error) => error.code ?? 'unknown').join(',')
		);
		return false;
	} catch (error) {
		console.warn('Clerk email request failed', error instanceof Error ? error.message : error);
		return false;
	}
}

