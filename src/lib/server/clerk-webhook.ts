import type { D1Database } from '@cloudflare/workers-types';
import { getExternalUserId, revokeUserAccess, syncExternalProfile } from './auth';

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

export type ClerkWebhookOutcome = 'revoked' | 'synced' | 'unknown_user' | 'ignored';

/**
 * Keep local accounts in step with Clerk.
 *
 * `user.deleted` revokes every credential the person holds but leaves their
 * mail and account row alone: a mistaken delete in Clerk must not be able to
 * erase a mailbox, and an admin can still remove the account deliberately.
 * Accounts are never created here; they are provisioned at sign-in, where the
 * allowlist applies.
 */
export async function handleClerkWebhook(
	db: D1Database,
	event: ClerkWebhookEvent
): Promise<ClerkWebhookOutcome> {
	const externalId = event.data?.id;
	if (!externalId || (event.type !== 'user.deleted' && event.type !== 'user.updated')) {
		return 'ignored';
	}

	const userId = await getExternalUserId(db, 'clerk', externalId);
	if (!userId) return 'unknown_user';

	if (event.type === 'user.deleted') {
		await revokeUserAccess(db, userId);
		return 'revoked';
	}

	const data = event.data ?? {};
	const primary = data.email_addresses?.find((entry) => entry.id === data.primary_email_address_id);
	await syncExternalProfile(db, 'clerk', externalId, {
		name: [data.first_name, data.last_name].filter(Boolean).join(' '),
		email: primary?.email_address
	});
	return 'synced';
}
