<script lang="ts">
	import { onMount } from 'svelte';
	import { loadClerk, type ClerkBrowser } from '$lib/clerk-client';
	import { t } from '$lib/i18n';

	let { publishableKey, next }: { publishableKey: string | null; next: string | null } = $props();

	const RETRY_FLAG = 'quickinbox:clerk-retry';

	let container: HTMLDivElement | undefined = $state();
	let status = $state<'loading' | 'ready' | 'refused' | 'error'>('loading');
	let clerk: ClerkBrowser | undefined;

	function retryFlag(value?: '1' | null): string | null {
		try {
			if (value === null) sessionStorage.removeItem(RETRY_FLAG);
			else if (value) sessionStorage.setItem(RETRY_FLAG, value);
			return sessionStorage.getItem(RETRY_FLAG);
		} catch {
			return null;
		}
	}

	/** Blend Clerk's card into ours: our card, our colors, our heading. */
	function appearance() {
		const css = getComputedStyle(document.documentElement);
		const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
		const flat = { boxShadow: 'none', background: 'transparent', border: 'none' };
		return {
			variables: {
				colorText: token('--color-text', '#111111'),
				colorTextSecondary: token('--color-text-secondary', '#666666'),
				colorBackground: token('--color-surface', '#ffffff'),
				colorInputBackground: token('--color-surface-muted', '#f3f3f3'),
				colorInputText: token('--color-text', '#111111'),
				colorPrimary: token('--color-accent', '#90ac9a'),
				colorTextOnPrimaryBackground: '#111111',
				borderRadius: '0.5rem'
			},
			elements: {
				rootBox: { width: '100%' },
				cardBox: { ...flat, width: '100%' },
				card: { ...flat, padding: 0, width: '100%' },
				// The page already shows the logo and "Sign in".
				header: { display: 'none' },
				// Access is decided by the server, not by whether Clerk offers sign-up.
				footerAction: { display: 'none' },
				footer: flat,
				socialButtonsBlockButton: {
					background: token('--color-surface-muted', '#f3f3f3'),
					border: '1px solid rgba(128, 128, 128, 0.25)'
				},
				socialButtonsBlockButtonText: { color: token('--color-text', '#111111') },
				dividerLine: { background: 'rgba(128, 128, 128, 0.3)' },
				dividerText: { color: token('--color-text-secondary', '#666666') }
			}
		};
	}

	onMount(async () => {
		if (!publishableKey) {
			status = 'error';
			return;
		}
		try {
			clerk = await loadClerk(publishableKey);
		} catch {
			status = 'error';
			return;
		}

		if (clerk.user) {
			// Clerk knows this person but the server sent them back here. The token
			// may just have been stale (loading Clerk refreshes it), so try once
			// more; a second bounce means the server refused the sign-in.
			if (!retryFlag()) {
				retryFlag('1');
				window.location.href = next ?? '/inbox';
				return;
			}
			status = 'refused';
			return;
		}

		retryFlag(null);
		status = 'ready';

		// Arriving from a Clerk invitation email: a new person needs the sign-up
		// form (Clerk reads the ticket from the URL and prefills the email).
		const params = new URLSearchParams(window.location.search);
		if (container && params.get('__clerk_ticket') && params.get('__clerk_status') === 'sign_up') {
			clerk.mountSignUp(container, {
				forceRedirectUrl: next ?? '/inbox',
				signInUrl: '/login',
				appearance: appearance()
			});
			return;
		}

		if (container) clerk.mountSignIn(container, {
				forceRedirectUrl: next ?? '/inbox',
				appearance: appearance()
			});
	});

	async function signOut() {
		retryFlag(null);
		await clerk?.signOut({ redirectUrl: '/login' });
	}
</script>

<div class="mt-8">
	{#if status === 'loading'}
		<p class="text-sm text-[var(--color-text-secondary)]">{t('auth.clerkLoading')}</p>
	{:else if status === 'error'}
		<p class="text-sm text-[var(--color-text-secondary)]">{t('auth.clerkUnavailable')}</p>
	{:else if status === 'refused'}
		<p class="text-sm text-[var(--color-text-secondary)]">{t('auth.clerkRefused')}</p>
		<button type="button" class="btn-primary mt-4 w-full py-2.5" onclick={signOut}>
			{t('auth.clerkSignOut')}
		</button>
	{/if}
	<div bind:this={container} class="flex justify-center"></div>
</div>
