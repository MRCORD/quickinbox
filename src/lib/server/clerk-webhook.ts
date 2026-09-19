import type { D1Database } from '@cloudflare/workers-types';
import { getExternalIdentity, revokeUserAccess, syncExternalProfile } from './auth';
import { restoreClerkPrimaryEmail } from './clerk-invite';

export type ClerkWebhookEvent = {
	type?: string;
	data?: {
		id?: string;
		first_name?: string | null;
		last_name?: string | null;
		primary_email_address_id?: string | null;
		email_addresses?: { id?: string; email_address?: string }[];
	};
};

export type ClerkWebhookOutcome =
	| 'revoked'
	| 'synced'
	| 'enforced'
	| 'enforce_failed'
	| 'unknown_user'
	| 'ignored';

/**
 * Keep local accounts in step with Clerk.
 *
 * `user.deleted` revokes every credential the person holds but leaves their
 * mail and account row alone: a mistaken delete in Clerk must not be able to
 * erase a mailbox, and an admin can still remove the account deliberately.
 *
 * `user.updated` mirrors name changes. For email, whoever's login is one of
 * their own mailboxes (their org identity) is held to it: if their Clerk
 * primary moves elsewhere, the org address is put back as primary and the
 * change is not copied here. Everyone else has email changes mirrored. Our own
 * correction fires another `user.updated`, which then matches and settles.
 *
 * Accounts are never created here; they are provisioned at sign-in, where the
 * allowlist applies.
 */
export async function handleClerkWebhook(
	db: D1Database,
	event: ClerkWebhookEvent,
	env: { CLERK_SECRET_KEY?: string } = {},
	fetcher: typeof fetch = fetch
): Promise<ClerkWebhookOutcome> {
	const externalId = event.data?.id;
	if (!externalId || (event.type !== 'user.deleted' && event.type !== 'user.updated')) {
		return 'ignored';
	}

	const identity = await getExternalIdentity(db, 'clerk', externalId);
	if (!identity) return 'unknown_user';

	if (event.type === 'user.deleted') {
		await revokeUserAccess(db, identity.id);
		return 'revoked';
	}

	const data = event.data ?? {};
	const primary = data.email_addresses?.find((entry) => entry.id === data.primary_email_address_id);
	const name = [data.first_name, data.last_name].filter(Boolean).join(' ');

	if (!identity.orgIdentity) {
		await syncExternalProfile(db, 'clerk', externalId, { name, email: primary?.email_address });
		return 'synced';
	}

	await syncExternalProfile(db, 'clerk', externalId, { name });

	const wanted = identity.email.toLowerCase();
	if (!primary?.email_address || primary.email_address.toLowerCase() === wanted) return 'synced';

	const existing = data.email_addresses?.find((entry) => entry.email_address?.toLowerCase() === wanted);
	const restored = await restoreClerkPrimaryEmail(env, externalId, identity.email, existing?.id ?? null, fetcher);
	if (!restored) console.warn('Org address is no longer primary in Clerk and could not be restored', externalId);
	return restored ? 'enforced' : 'enforce_failed';
}
