import { json, type RequestHandler } from '@sveltejs/kit';
import { createInvitedUser, createUser, deletePendingInvite, deletePendingUser, listUsers } from '$lib/server/auth';
import { isClerkMode } from '$lib/server/clerk-auth';
import { createAddress, getDomain, listAllAddresses } from '$lib/server/domains';

export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const [users, addresses] = await Promise.all([listUsers(db), listAllAddresses(db)]);
	return json({ users, addresses });
};

/**
 * Creates a user and their mailbox together — the address doubles as the login,
 * so an invited user lands straight in their inbox with nothing to configure.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	if (isClerkMode(platform?.env)) return inviteClerkUser(request, platform);

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const body = (await request.json()) as {
		name?: string;
		domainId?: string;
		localPart?: string;
		password?: string;
		isAdmin?: boolean;
	};

	if (!body.name?.trim() || !body.localPart?.trim() || !body.domainId) {
		return json({ error: 'Name, address, and domain are required' }, { status: 400 });
	}

	if (!body.password || body.password.length < 8) {
		return json({ error: 'Password must be at least 8 characters' }, { status: 400 });
	}

	const domain = await getDomain(db, body.domainId);
	if (!domain) {
		return json({ error: 'Domain is not connected' }, { status: 400 });
	}

	const localPart = body.localPart.trim().toLowerCase().replace(/@.*$/, '');

	let createdUserId: string | null = null;
	try {
		const user = await createUser(db, {
			email: `${localPart}@${domain.name}`,
			name: body.name,
			password: body.password,
			isAdmin: body.isAdmin === true,
			mustChangePassword: true
		});
		createdUserId = user.id;

		const address = await createAddress(db, {
			userId: user.id,
			domainId: domain.id,
			localPart
		});

		return json({ user, address }, { status: 201 });
	} catch (error) {
		if (createdUserId) {
			try {
				await deletePendingUser(db, createdUserId);
			} catch (cleanupError) {
				console.error('Failed to roll back user after mailbox creation failed', cleanupError);
			}
		}
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to create user' },
			{ status: 400 }
		);
	}
};

/**
 * Clerk mode: no passwords. The admin names the person, the address they sign
 * in with, and the mailbox they get. The account is claimed when they first
 * sign in with that email.
 */
async function inviteClerkUser(
	request: Request,
	platform: App.Platform | undefined
): Promise<Response> {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const body = (await request.json()) as {
		name?: string;
		email?: string;
		domainId?: string;
		localPart?: string;
		isAdmin?: boolean;
	};

	if (!body.name?.trim() || !body.email?.trim() || !body.localPart?.trim() || !body.domainId) {
		return json({ error: 'Name, sign-in email, address, and domain are required' }, { status: 400 });
	}

	const domain = await getDomain(db, body.domainId);
	if (!domain) {
		return json({ error: 'Domain is not connected' }, { status: 400 });
	}

	const localPart = body.localPart.trim().toLowerCase().replace(/@.*$/, '');

	let invitedUserId: string | null = null;
	try {
		const user = await createInvitedUser(db, {
			email: body.email,
			name: body.name,
			provider: 'clerk',
			isAdmin: body.isAdmin === true
		});
		invitedUserId = user.id;

		const address = await createAddress(db, { userId: user.id, domainId: domain.id, localPart });
		return json({ user, address }, { status: 201 });
	} catch (error) {
		if (invitedUserId) {
			try {
				await deletePendingInvite(db, invitedUserId);
			} catch (cleanupError) {
				console.error('Failed to roll back invite after mailbox creation failed', cleanupError);
			}
		}
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to invite user' },
			{ status: 400 }
		);
	}
}
