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
		if (container) clerk.mountSignIn(container, { forceRedirectUrl: next ?? '/inbox' });
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
