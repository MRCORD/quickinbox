import type { D1Database } from '@cloudflare/workers-types';
import type { User } from '$lib/types';
import { createSession, ExternalAuthError, upsertExternalUser } from './auth';
import { makeClerkEmailPrimary } from './clerk-invite';

/** Set by Clerk's frontend SDK; carries the short-lived session JWT. */
export const CLERK_SESSION_COOKIE = '__session';

export type ClerkEnv = {
	/** `password` (default) or `clerk`. */
	AUTH_MODE?: string;
	/** Instance PEM public key (Clerk dashboard > API keys > JWKS public key). */
	CLERK_JWT_KEY?: string;
	/** Clerk secret key; lets a claimed invite make its org address the primary email in Clerk. */
	CLERK_SECRET_KEY?: string;
	/** Comma-separated origins allowed as the token's `azp`. Recommended. */
	CLERK_AUTHORIZED_PARTIES?: string;
	/** Comma-separated emails that become admins on first sign-in. */
	ADMIN_EMAILS?: string;
	/**
	 * Who may be auto-provisioned besides admins: comma-separated emails,
	 * `@domain` suffixes, or `*` for anyone the IdP authenticates. Unset means
	 * only the first user and admins.
	 */
	ALLOWED_EMAILS?: string;
};

export function isClerkMode(env: ClerkEnv | undefined): boolean {
	return env?.AUTH_MODE === 'clerk';
}

function splitList(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
}

type Claims = Record<string, unknown> & { sub: string };

async function verifyClerkToken(env: ClerkEnv, clerkToken: string): Promise<Claims | null> {
	const jwtKey = env.CLERK_JWT_KEY?.replace(/\\n/g, '\n').trim();
	if (!jwtKey) {
		console.error('AUTH_MODE=clerk is set but CLERK_JWT_KEY is missing');
		return null;
	}

	const { verifyToken } = await import('@clerk/backend');
	const authorizedParties = (env.CLERK_AUTHORIZED_PARTIES ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

	// The public export returns the payload and throws when verification fails.
	try {
		const claims = await verifyToken(clerkToken, {
			jwtKey,
			...(authorizedParties.length > 0 ? { authorizedParties } : {})
		});
		return claims?.sub ? (claims as Claims) : null;
	} catch (error) {
		// Expired tokens are routine; anything else (wrong key, azp) is config.
		const reason = (error as { reason?: string }).reason ?? 'unknown';
		if (reason !== 'token-expired') console.warn('Clerk session token rejected:', reason);
		return null;
	}
}

/**
 * Does the Clerk session in this browser belong to the local user already
 * signed in here? A different person signing in to Clerk must not inherit the
 * previous person's local session. A token that can't be verified gives no
 * opinion (true): expiry is Clerk's to handle, not a reason to drop a session.
 */
export async function clerkSessionMatchesUser(
	db: D1Database,
	env: ClerkEnv,
	clerkToken: string,
	userId: string
): Promise<boolean> {
	const claims = await verifyClerkToken(env, clerkToken);
	if (!claims) return true;

	const row = await db
		.prepare("SELECT id FROM users WHERE auth_provider = 'clerk' AND external_id = ?")
		.bind(claims.sub)
		.first<{ id: string }>();
	return row?.id === userId;
}

/**
 * Trade a Clerk session JWT for a local session. Verification is networkless
 * (the instance PEM), and the result is an ordinary `sessions` row, so
 * revocation, devices, API tokens and the account switcher all keep working.
 *
 * The session token must carry `email` (and ideally `name`) claims: add
 * `{"email": "{{user.primary_email_address}}", "name": "{{user.full_name}}"}`
 * under Sessions > Customize session token in the Clerk dashboard.
 *
 * Returns null for anything that should fall through to "not signed in".
 */
export async function exchangeClerkSession(
	db: D1Database,
	env: ClerkEnv,
	clerkToken: string,
	fetcher: typeof fetch = fetch
): Promise<{ user: User; token: string; sessionId: string } | null> {
	const claims = await verifyClerkToken(env, clerkToken);
	if (!claims) return null;

	const { email, name } = claims;
	if (typeof email !== 'string') {
		console.error('Clerk session token has no `email` claim; customize the session token');
		return null;
	}

	try {
		const { user, claimed } = await upsertExternalUser(db, {
			provider: 'clerk',
			externalId: claims.sub,
			email,
			name: typeof name === 'string' ? name : '',
			adminEmails: splitList(env.ADMIN_EMAILS),
			allowedEmails: splitList(env.ALLOWED_EMAILS)
		});

		// Just claimed an invite made at their personal email: make the org address
		// their primary email in Clerk too. Only at the claim, never on later
		// sign-ins, so a lagging webhook can't make this undo a change of theirs.
		if (claimed && user.email !== email.toLowerCase().trim()) {
			await makeClerkEmailPrimary(env, claims.sub, user.email, fetcher);
		}

		const session = await createSession(db, user.id);
		return { user, ...session };
	} catch (error) {
		if (error instanceof ExternalAuthError) {
			console.warn('Clerk sign-in refused:', error.message);
			return null;
		}
		throw error;
	}
}
