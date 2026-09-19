import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import type { ApiScope, AuthMethod } from '$lib/server/api-access';
import type { CloudflareSendEmailBinding } from '$lib/server/providers/cloudflare-provider';
import type { Domain, LinkedAccount, MailAddress, User } from '$lib/types';

declare global {
	namespace App {
		interface Platform {
			ctx: ExecutionContext;
			env: {
				DB: D1Database;
				ATTACHMENTS: R2Bucket;
				ASSETS: Fetcher;
				EMAIL: CloudflareSendEmailBinding;
				/** `resend` (default) or `cloudflare`. */
				EMAIL_PROVIDER?: string;
				/** Comma-separated domains when EMAIL_PROVIDER=cloudflare. */
				CLOUDFLARE_MAIL_DOMAINS?: string;
				/** Resend API key — `wrangler secret put RESEND_API_KEY`. */
				RESEND_API_KEY: string;
				/** Signing secret from the Resend webhook (whsec_…). */
				RESEND_WEBHOOK_SECRET: string;
				/** Web Push application server public key. */
				VAPID_PUBLIC_KEY?: string;
				/** Web Push application server private key. */
				VAPID_PRIVATE_KEY?: string;
				/** A mailto: or https: contact URI for Web Push. */
				VAPID_SUBJECT?: string;
				/** Bot token from @BotFather — enables Telegram notifications. */
				TELEGRAM_BOT_TOKEN?: string;
				/** Chat, group, or channel the notifications go to. */
				TELEGRAM_CHAT_ID?: string;
				/** Topic id when the chat is a forum supergroup. */
				TELEGRAM_THREAD_ID?: string;
				/** Public URL of this install, linked from notifications. */
				APP_URL?: string;
				/** `password` (default) or `clerk` — see docs on AUTH_MODE. */
				AUTH_MODE?: string;
				/** Clerk publishable key (pk_…); public, used by the sign-in screen. */
				CLERK_PUBLISHABLE_KEY?: string;
				/** Clerk secret key (sk_…): lets the admin invite send a Clerk invitation email. Optional. */
				CLERK_SECRET_KEY?: string;
				/** Clerk instance PEM public key; required when AUTH_MODE=clerk. */
				CLERK_JWT_KEY?: string;
				/** Comma-separated origins accepted as the Clerk token's `azp`. */
				CLERK_AUTHORIZED_PARTIES?: string;
				/** Comma-separated emails made admin on first Clerk sign-in. */
				ADMIN_EMAILS?: string;
				/** Signing secret (whsec_…) of the Clerk webhook at /api/webhooks/clerk. */
				CLERK_WEBHOOK_SECRET?: string;
				/** Emails, `@domain` suffixes or `*` allowed to be auto-provisioned in clerk mode. */
				ALLOWED_EMAILS?: string;
				/** Optional TypeSafe key for inbound category/spam classification. */
				TYPESAFE_API_KEY?: string;
			};
		}
		interface Locals {
			user: User | null;
			/** How this request authenticated — sessions are unrestricted. */
			authMethod: AuthMethod | null;
			/** Scopes on the bearer token; empty for a browser session. */
			apiScopes: ApiScope[];
			apiTokenId: string | null;
			/** Connected domains, loaded once per request for the switcher. */
			domains: Domain[];
			/** The signed-in user's sending identities. */
			addresses: MailAddress[];
			/** Active domain filter, or null for the combined inbox. */
			activeDomainId: string | null;
			/** Server-only id of the session credential used for this request. */
			currentSessionId: string | null;
			/** Every account signed in on this browser (active first). Page requests only. */
			accounts: LinkedAccount[];
			/** Active UI theme id (Zero, Classic, or a drop-in folder). */
			uiTheme: string;
			/** Active UI locale (en, fr, zh-CN, es). */
			locale: string;
		}
	}
}

export {};
