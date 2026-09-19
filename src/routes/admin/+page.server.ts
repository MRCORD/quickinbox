import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listAllMobileDeviceSessions, listUsers } from '$lib/server/auth';
import {
	safeEmailProviderKind,
	listAvailableDomains,
	providerLoadError
} from '$lib/server/context';
import { isClerkMode } from '$lib/server/clerk-auth';
import { listAllAddresses, listUnroutedEmails } from '$lib/server/domains';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.user?.is_admin) {
		throw error(403, 'Forbidden');
	}

	const providerKind = safeEmailProviderKind(platform);
	const authMode = isClerkMode(platform?.env) ? ('clerk' as const) : ('password' as const);
	const db = platform?.env.DB;
	if (!db) {
		return {
			users: [],
			addresses: [],
			domains: locals.domains,
			available: [],
			unrouted: [],
			devices: [],
			providerKind,
			authMode,
			loadError: 'Database unavailable'
		};
	}

	const [users, addresses, unrouted, devices] = await Promise.all([
		listUsers(db),
		listAllAddresses(db),
		listUnroutedEmails(db, 25),
		listAllMobileDeviceSessions(db)
	]);

	try {
		const available = await listAvailableDomains(
			platform,
			locals.domains.map((domain) => domain.id)
		);

		return {
			users,
			addresses,
			unrouted,
			devices,
			domains: locals.domains,
			available,
			providerKind,
			authMode,
			loadError: null
		};
	} catch (err) {
		return {
			users,
			addresses,
			unrouted,
			devices,
			domains: locals.domains,
			available: [],
			providerKind,
			authMode,
			loadError: providerLoadError(providerKind, err)
		};
	}
};
