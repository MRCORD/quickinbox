import type { PageServerLoad } from './$types';
import { isClerkMode } from '$lib/server/clerk-auth';

export const load: PageServerLoad = async ({ platform }) => {
	const env = platform?.env;
	return {
		authMode: isClerkMode(env) ? ('clerk' as const) : ('password' as const),
		// Publishable keys are public by design; the secret never leaves the server.
		clerkPublishableKey: env?.CLERK_PUBLISHABLE_KEY ?? null
	};
};
