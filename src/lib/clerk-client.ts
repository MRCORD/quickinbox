/** Minimal surface of the Clerk browser SDK that the sign-in screen uses. */
export type ClerkBrowser = {
	load(): Promise<void>;
	user?: unknown;
	mountSignIn(
		node: HTMLElement,
		props: { forceRedirectUrl?: string; appearance?: Record<string, unknown> }
	): void;
	signOut(options?: { redirectUrl?: string }): Promise<void>;
};

/**
 * A publishable key is `pk_(test|live)_` + base64 of `<frontend-api-host>$`.
 * Returns null for anything that doesn't decode to a plausible host.
 */
export function frontendApiHost(publishableKey: string): string | null {
	const encoded = publishableKey.split('_')[2];
	if (!encoded) return null;
	try {
		const host = atob(encoded).replace(/\$$/, '');
		return /^[a-z0-9.-]+$/i.test(host) ? host : null;
	} catch {
		return null;
	}
}

/** Load clerk-js from the instance's own frontend API host, once. */
export async function loadClerk(publishableKey: string): Promise<ClerkBrowser> {
	const host = frontendApiHost(publishableKey);
	if (!host) throw new Error('Invalid Clerk publishable key');

	const existing = (window as unknown as { Clerk?: ClerkBrowser }).Clerk;
	if (!existing) {
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement('script');
			script.src = `https://${host}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
			script.async = true;
			script.crossOrigin = 'anonymous';
			script.setAttribute('data-clerk-publishable-key', publishableKey);
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('Could not load Clerk'));
			document.head.append(script);
		});
	}

	const clerk = (window as unknown as { Clerk?: ClerkBrowser }).Clerk;
	if (!clerk) throw new Error('Clerk did not initialise');
	await clerk.load();
	return clerk;
}
