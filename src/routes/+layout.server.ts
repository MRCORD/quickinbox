import type { LayoutServerLoad } from './$types';
import { isClerkMode } from '$lib/server/clerk-auth';
import { emptyMailboxCounts } from '$lib/mail/categories';
import { listLabels } from '$lib/server/labels';
import { getMailboxCounts } from '$lib/server/mail-store';
import { DEFAULT_UI_THEME } from '$lib/ui-theme/ids';
import { DEFAULT_LOCALE } from '$lib/i18n/locales';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	const ready = Boolean(db && locals.user && !locals.user.must_change_password);

	// The sidebar shows these on every page, so they load with the shell.
	const counts = ready
		? await getMailboxCounts(db!, locals.user!.id, locals.activeDomainId)
		: emptyMailboxCounts();
	const labels = ready ? await listLabels(db!, locals.user!.id) : [];

	const clerk = isClerkMode(platform?.env);

	return {
		user: locals.user,
		// Lets the account menu offer Clerk's "Manage account". The key is public.
		authMode: clerk ? ('clerk' as const) : ('password' as const),
		clerkPublishableKey: clerk ? (platform?.env.CLERK_PUBLISHABLE_KEY ?? null) : null,
		domains: locals.domains,
		addresses: locals.addresses,
		activeDomainId: locals.activeDomainId,
		accounts: locals.accounts,
		counts,
		labels,
		uiTheme: locals.uiTheme ?? DEFAULT_UI_THEME,
		locale: locals.locale ?? DEFAULT_LOCALE
	};
};
