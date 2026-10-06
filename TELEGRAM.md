# Quiet cart preparation and Telegram

In the extension popup, open **Cart experience** and choose **Show progress on screen**, **Notify me when my cart is ready**, or **Send my cart to Telegram**. Click Save. The linked account name is displayed prominently in the account card. **Disconnect account** revokes the connection; **Silent Telegram messages** follows the account controls and defaults to off. The nudge is dismissible and opens the normal cart review when clicked. Telegram mode keeps the video free of progress and cart overlays.

## Server setup

Create your bot through Telegram's BotFather and set the token in the server's repository-level `.env`:

```
TELEGRAM_BOT_TOKEN=<BotFather token>
TELEGRAM_TRANSPORT=auto
```

For local development with an HTTP `PUBLIC_BASE_URL`, auto mode uses long polling and needs no inbound tunnel. For production, configure the deployed server's HTTPS `PUBLIC_BASE_URL` and:

```
TELEGRAM_WEBHOOK_SECRET=<at least 32 random letters, digits, underscores or hyphens>
```

Auto mode uses the HTTPS endpoint `/telegram/webhook` and verifies Telegram's secret header. The companion GitHub Pages/edge-proxy setup includes an exact `/telegram/webhook` Worker route; redeploy the Worker to activate it. The proxy preserves the body and Telegram secret header, and the API verifies that header. All device-facing Telegram APIs use `/api/*`. Set `TELEGRAM_TRANSPORT=polling` or `webhook` to choose explicitly. A bot can have only one active update transport: use separate development and production bots. Restart the API after configuring it. MongoDB persists cart threads; Redis persists links, callback records, active cart reservations, delivery jobs, and polling offsets. Keep the production MongoDB and Redis data durable across restarts.

Reload the extension, click **Connect Telegram**, press **Start** in the bot chat, then reopen the extension and confirm the displayed Telegram account. Select Telegram delivery and save. Usernames alone cannot link an account. Disconnecting removes authorization for old bot buttons and restores the on-screen experience.

## Checkout

When an HTTPS product image is available, Telegram receives a photo followed by the interactive receipt. A photo rejected by Telegram falls back to the receipt alone. Receipts use Telegram HTML rich text: bold restaurant/items/payable, separate delivery/address/expiry sections, and a spaced confirmation reminder. Long receipts are split without cutting formatting; checkout buttons stay on the final receipt message. Messages contain the verified receipt, payable amount, delivery address, estimate and expiry. Only currently offered payment methods are displayed. Choosing a method presents a separate confirmation button; preparation and method selection never place an order. Money and COD use inline checkout. UPI sends a Swiggy payment link when available and a QR image. The server checks pending payments at a bounded cadence and updates the cart message when terminal; **Check payment** also permits a manual refresh.

Cart ownership, short-lived callback tokens and receipt revision checks protect bot actions. Browser and Telegram checkout share the same atomic claim, so simultaneous confirmations cannot submit two orders. Changed cart items or payable amounts require a fresh review. Uncertain payment outcomes remain locked for review in the Swiggy app rather than triggering another submission.

One active cart is permitted per authenticated extension connection. Automatic detection resumes after dismissal, completion or cart expiry. Failed or uncertain checkout remains blocked until the reservation expires; check Swiggy before preparing another cart. Connections on different devices are separate, so users should avoid concurrently preparing carts for the same Swiggy account on multiple devices.

## Privacy and operation

Detection and local identification still run in the browser; frames are not sent to Telegram. Telegram receives cart and delivery-address details, explanations requested by the user, and payment status/QR requests. The saved hosted-fallback policy continues to apply. In Telegram mode, an Ask approval is sent to the linked private chat, never to a browser confirmation dialog. The browser must remain running for local inference. Telegram delivery is retried from Redis while the cart remains valid; blocking the bot prevents delivery. No order is submitted as a consequence of a detection or message delivery.

## Follow-up requests and payment cancellation

Send a private text request of up to 500 characters to update your current cart, or reply to its receipt/product photo to identify a specific cart. CraveLens deduplicates incoming messages, acknowledges the request, then uses the same customization service as the browser: ownership/status claim, current receipt and conversation context, model/tool preparation, verified cart and refreshed explanation. Review the new receipt and explicitly confirm again. Old receipt buttons are removed or rejected by revision checks. Expired carts, carts currently being edited and carts in checkout cannot be edited. Queued requests persist in Redis; an interrupted mutation is held for manual review rather than replayed automatically.

The UPI waiting message and **Check payment** response include **Cancel payment process**. Cancellation rechecks live status and stops CraveLens tracking only while pending. It does not cancel or refund a transfer in your UPI app. If payment has succeeded, check the order status instead; unknown outcomes require review in Swiggy. Both browser and Telegram use the same cancellation service.

**Why this cart?** now uses spaced points for preference fit, dish relevance, availability and verified tradeoffs. The browser renders a Markdown list; Telegram displays the same points as bullets, including the separate verified coupon fact.

When explicit food preferences are absent, cart preparation first generates or reuses the same encrypted history-based profile used by browser carts, scoped to the Swiggy connection and address. Tentative profiles are reused for up to 30 days; empty-history checks are repeated after a day without inventing preferences. The saved fallback policy still applies, including approval in Telegram when configured. A multi-dish scan supplies all recognized dishes to one cart agent; it does not create separate restaurant carts or orders. Follow-up customization retains that original dish list and inferred/explicit provenance. Review inferred patterns and the receipt before explicit checkout.

## Optional workflow diagnostics

When Langfuse is configured, delivery and the shared checkout/customization workflows join the cart conversation session. Telegram API calls record method names and timing; message bodies, chat identifiers, bot tokens, callback payloads and payment details are excluded from exports. Linking API calls have standalone traces; idle polling is excluded. Tracing does not change delivery retries, confirmation, ownership or duplicate-submission checks. A successful export does not establish successful Telegram delivery or payment.
