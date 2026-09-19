import { json, text, type RequestHandler } from '@sveltejs/kit';
import { claimWebhookEvent } from '$lib/server/inbound';
import { handleClerkWebhook, type ClerkWebhookEvent } from '$lib/server/clerk-webhook';
import { verifyWebhookSignature } from '$lib/server/webhook';

/**
 * Clerk webhook receiver (AUTH_MODE=clerk). Point a webhook at
 * https://<your-app>/api/webhooks/clerk in the Clerk dashboard, subscribe to
 * `user.updated` and `user.deleted`, and set CLERK_WEBHOOK_SECRET to its
 * signing secret. Clerk signs with Svix, the same scheme Resend uses.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Storage unavailable' }, { status: 503 });

	const secret = platform?.env.CLERK_WEBHOOK_SECRET;
	if (!secret) {
		console.error('Rejected webhook: CLERK_WEBHOOK_SECRET is not configured');
		return json({ error: 'Webhook secret not configured' }, { status: 503 });
	}

	// Must be the raw body: parsing first would invalidate the signature.
	const rawBody = await request.text();
	const verified = await verifyWebhookSignature(request.headers, rawBody, secret);
	if (!verified.ok) {
		console.warn('Rejected Clerk webhook signature:', verified.reason);
		return json({ error: 'Invalid signature' }, { status: 401 });
	}

	let event: ClerkWebhookEvent;
	try {
		event = JSON.parse(rawBody) as ClerkWebhookEvent;
	} catch {
		return json({ error: 'Invalid JSON payload' }, { status: 400 });
	}

	const eventId =
		request.headers.get('svix-id') ?? request.headers.get('webhook-id') ?? crypto.randomUUID();
	if (!(await claimWebhookEvent(db, eventId, event.type ?? 'unknown'))) {
		return text('Duplicate event ignored', { status: 200 });
	}

	try {
		return json({ ok: true, outcome: await handleClerkWebhook(db, event) });
	} catch (error) {
		// Release the claim so Clerk's retry can succeed.
		await db.prepare('DELETE FROM webhook_events WHERE id = ?').bind(eventId).run();
		console.error('Clerk webhook handling failed', event.type, error);
		return json({ error: 'Webhook handling failed' }, { status: 500 });
	}
};
