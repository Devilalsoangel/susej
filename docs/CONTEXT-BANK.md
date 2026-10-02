# Susej Context Bank

Last updated: 2026-09-25
Repository: `C:\Users\TONI\projects\social-commerce`
Purpose: durable, editable context for buyer-first E2E auditing, fixes, and later seller/admin work.

## Operating rules

- Source-confirmed and runtime-verified are different states.
- A release APK is the final auth/navigation test target; Expo Go is for fast development iteration only.
- Buyer flows are first. Seller and admin changes are allowed when they are the source of a buyer defect.
- Every fix requires the relevant typecheck/build and a real-surface verification path.
- No finding is closed from an API probe alone when a user surface can be tested.
- Device work uses serialized USB ADB, UI-tree dumps, foreground-package checks, and bounded commands.

## Runtime truth

- USB device: `10BD581KPP0006T`, vivo V2246.
- Release package: `com.susej.app`.
- Current release metadata: `versionName=1.1.1`, `versionCode=2`.
- Hosted app API: `https://susej-admin-panel-theta.vercel.app`.
- Legacy bare Vercel host is stale and must not be used.
- API probe: `POST /api/app/auth/check` with `919442730086` returned `200 {"exists":true}`.
- Release APK source: `Frontend/android/app/build/outputs/apk/release/app-release.apk`.
- Release build completed successfully before device installation; final artifact hash is recorded in the session evidence log.
- Local app data was cleared once for a clean auth attempt; no live database rows were deleted.

## Route inventory

### Buyer shell and auth

- `/`
- `/login`
- `/(onboarding)/welcome`
- `/(onboarding)/auth`
- `/(onboarding)/otp`
- `/(onboarding)/location`
- `/(onboarding)/profile-setup`
- `/(onboarding)/interests`
- `/(onboarding)/first-feed`

### Buyer tabs and discovery

- `/(tabs)/feed`
- `/(tabs)/explore`
- `/(tabs)/orders`
- `/(tabs)/chat`
- `/(tabs)/profile`
- `/(tabs)/creator` and `/(tabs)/create` are seller-gated.
- `/search`, `/foryou`, `/category`, `/category/[slug]`, `/map`
- `/hashtag/[tag]`, `/saved`, `/saved-searches`

### Buyer commerce and orders

- `/product/[id]`, `/cart`, `/checkout`, `/book-service`, `/compare`, `/bundles`
- `/orders`, `/order/[id]`, `/track-order`, `/rate-review`
- `/refunds`, `/refund/[id]`, `/disputes`, `/dispute/[id]`

### Buyer social and account

- `/communities`, `/community/[id]`, `/broadcasts`, `/broadcast/[id]`
- `/story/[username]`, `/seller/[username]`
- `/settings`, `/edit-profile`, `/wallet`, `/address-book`, `/payment-methods`
- `/notifications`, `/blocked`, `/support`, `/support/[id]`

### Seller surface

- `/become-seller`
- `/seller-dashboard-hub`, `/seller-dashboard`
- `/edit-shop`, `/categories-manager`, `/storefront-editor`
- `/listings-manager`, `/edit-listing/[id]`, `/bundles`, `/promotions`
- `/seller-orders`, `/wallet`, `/start-live`, `/start-auction`
- `/auctions`, `/auction/[id]`

### Admin surface

- `susej-admin-panel/src/app/dashboard/**`
- `susej-admin-panel/src/app/api/**`
- `susej-admin-panel/src/lib/app-auth.ts`
- `susej-admin-panel/prisma/schema.prisma`

## Stable context entries

| ID | Area | Source | State | Runtime check |
|---|---|---|---|---|
| BUY-SHELL-01 | Auth shell and providers | `Frontend/app/_layout.tsx:135-253` | Source mapped | Fresh install, return, logout, switch account |
| BUY-AUTH-01 | Phone/email/Google/OTP | `Frontend/app/login.tsx:28-301`; `app/(onboarding)/auth.tsx`; `app/(onboarding)/otp.tsx` | Source mapped; release path incomplete | Valid, invalid, unknown, wrong, resend, expiry |
| BUY-ONBOARD-01 | Location/profile/interests/first feed | `app/(onboarding)/location.tsx`; `profile-setup.tsx`; `interests.tsx`; `first-feed.tsx` | Source mapped | Clean signup and returning account |
| BUY-FEED-01 | Feed/story/home rails | `app/(tabs)/feed.tsx`; `app/story/[username].tsx` | Source mapped | Real rows, empty, offline, refresh |
| BUY-SEARCH-01 | Search and suggestions | `app/search.tsx`; `utils/serverApi.ts` | Source mapped | Partial names, products, users, categories |
| BUY-PDP-01 | Product detail | `app/product/[id].tsx` | Source mapped | Deep link, variants, stock, CTA, engagement |
| BUY-CART-01 | Cart | `app/cart.tsx`; `contexts/CartContext.tsx` | Source mapped; race risk | Seller guard, quantity, coupon, checkout tap |
| BUY-CHECKOUT-01 | Checkout | `app/checkout.tsx`; `contexts/OrderContext.tsx` | Source mapped | Address, payment, price/stock, one order |
| BUY-ORDERS-01 | Orders and tracking | `app/orders.tsx`; `order/[id].tsx`; `track-order.tsx` | Source mapped | Status, cancel, return, tracking |
| BUY-CHAT-01 | DMs/offers | `app/(tabs)/chat.tsx`; `contexts/CommunityContext.tsx` | Source mapped | Two-account message and offer lifecycle |
| BUY-COMMUNITY-01 | Communities | `app/communities.tsx`; `community/[id].tsx` | Source mapped | Join, message, poll, two-device state |
| BUY-STORE-01 | Public seller storefront | `app/seller/[username].tsx`; `components/StorefrontSections.tsx` | Source mapped; dead controls risk | Every archetype and CTA |
| BUY-ACCOUNT-01 | Profile/settings/wallet | `app/(tabs)/profile.tsx`; `settings.tsx`; `wallet.tsx` | Source mapped | Logout, switch, account-scoped data |
| BUY-SUPPORT-01 | Support tickets | `app/support.tsx`; `support/[id].tsx`; `utils/adminSync.ts` | Source mapped; server sync risk | Create, reply, offline retry, second device |
| BUY-DATA-01 | Server/cache transport | `utils/serverApi.ts`; `adminSync.ts`; `sessionStorage.ts` | Source mapped | Timeout, retry, stale session, cache isolation |
| SELLER-IDENTITY-01 | Seller approval/gates | `become-seller.tsx`; `AuthContext.tsx`; `utils/marketplace.ts` | Source mapped | Approval → logout → login |
| SELLER-CATALOG-01 | Listings/storefront | `listings-manager.tsx`; `storefront-editor.tsx`; `edit-shop.tsx` | Source mapped | Two listings, cross-device edit/delete |
| SELLER-PAYOUT-01 | Wallet/payouts | `wallet.tsx`; `utils/walletStore.ts` | Source mapped; local-history risk | Clear storage and second device |
| ADMIN-AUTH-01 | Admin auth/session | `susej-admin-panel/src/lib/auth.ts`; `app-auth.ts` | Source mapped | Fresh-cookie browser login and RBAC |
| ADMIN-MONEY-01 | Orders/refunds/payouts | `susej-admin-panel/src/app/api/**`; `prisma/schema.prisma` | Source mapped | Ledger reconciliation and mutation audit |
| ADMIN-IDENTITY-01 | Seller/KYC/reports | `susej-admin-panel/src/app/api/data/**`; `app/api/app/**` | Source mapped; auth boundary risk | Cross-user and role checks |

## Confirmed source findings

### Auth, session, and identity

- `AUTH-001` Existing-account onboarding is device-local: `AuthContext.tsx:111-117,173-179,406-419`; a fresh install can send an existing account through onboarding.
- `AUTH-002` Startup trusts stored user/session presence without authoritative `/users/me` validation: `AuthContext.tsx:97-110`; `sessionStorage.ts:43-65`.
- `AUTH-003` `reconcileIdentity()` is defined but not called after OTP, email, or Google login: `AuthContext.tsx:239-255,257-344`.
- `AUTH-004` AsyncStorage is ordinary plaintext storage despite secure naming: `sessionStorage.ts:1-4,25-35`.
- `AUTH-005` Pending revoke retry is only wired through OTP login: `AuthContext.tsx:275-287,306-343`; email/Google paths do not retry it.
- `AUTH-006` Logout copy says sign out everywhere but requests only the current session: `AuthContext.tsx:346-373`; `serverApi.ts:489-491`; `api/app/auth/route.ts:151-157`.
- `AUTH-007` Deactivate/delete account UI paths only log out: `app/password-security.tsx`, `app/edit-profile.tsx`.
- `AUTH-008` Production `AUTH_DEV_MODE=1` can expose `devCode`: `susej-admin-panel/src/app/api/app/auth/route.ts:115-130`.
- `AUTH-009` Phone identity fallback can select a foreign-shaped account by last-ten digits: `susej-admin-panel/src/lib/app-auth.ts:136-150`.
- `AUTH-010` Release admin URL cache accepts local/debug URLs; only the bare stale host is filtered: `Frontend/utils/adminSync.ts:51-65`.

### Buyer and data integrity

- `BUY-001` Support reply is local-only: `Frontend/app/support/[id].tsx:74-88`.
- `BUY-002` Ticket opener message failure is discarded and the outbox is cleared: `utils/adminSync.ts:324-332`.
- `BUY-003` Support detail can migrate a global ticket into the current account: `app/support/[id].tsx:44-46`.
- `BUY-004` Cold seller storefront ignores server posts and can show empty: `app/seller/[username].tsx:313-354,498-557`.
- `BUY-005` Storefront Book Now discards the tapped service ID: `app/seller/[username].tsx:872`.
- `BUY-006` Map does not filter blocked sellers: `app/map.tsx`.
- `BUY-007` Public username lookup can fuzzy-match the wrong user: `susej-admin-panel/src/app/api/app/users/[username]/route.ts:22-37`.
- `BUY-008` Post likes/comments/share can treat `{ok:false}` as success: `contexts/PostContext.tsx:852-880`; `components/sheets/PostEngagementSheets.tsx:244-303,637-659`.
- `BUY-009` Cart same-tick cross-seller mutation has a state-updater race: `contexts/CartContext.tsx:107-138`.
- `BUY-010` Interests completion can advance before the server PATCH succeeds: `app/(onboarding)/interests.tsx:80,191-193`.
- `BUY-011` Profile setup hard-blocks signup when avatar or username check is unavailable: `app/(onboarding)/profile-setup.tsx:100-111,140-205`.
- `BUY-012` Public server-read cache generations leave old private responses in AsyncStorage: `utils/serverApi.ts:251-255,365-370,445-450`.
- `BUY-013` Dispute detail has no server fallback and can be incomplete on another device: `app/dispute/[id].tsx:35-82`.
- `BUY-014` Story reactions and hashtag follows are device-local: `app/story/[username].tsx:335-353`; `app/hashtag/[tag].tsx:83-95`.

### Seller and admin

- `SELLER-001` Seller identity/KYC approval state can remain stale after login: `AuthContext.tsx:239-255`; `become-seller.tsx:206-209`.
- `SELLER-002` Initial post/order sync marks seeded before success: `contexts/PostContext.tsx:382-424`; `contexts/OrderContext.tsx:382-405`.
- `SELLER-003` Seller editors/banners/payout history are not fully cross-device hydrated: `storefront-editor.tsx`; `edit-shop.tsx`; `wallet.tsx`.
- `SELLER-004` Auction storage is global and deep links can miss server-only rows: `start-auction.tsx`; `auction/[id].tsx`.
- `SELLER-005` Applicant PII remains in global AsyncStorage after failed sync: `become-seller.tsx:830-879`; `AuthContext.clearMoneyCache()` omits it.
- `ADMIN-001` Local app admin verify/report routes lack a real admin role gate and do not mutate the server: `Frontend/app/admin/verify.tsx`; `Frontend/app/admin/reports.tsx`.
- `ADMIN-002` Direct generic seller PATCH can bypass KYC re-verification: `susej-admin-panel/src/app/api/data/[resource]/route.ts:449-496,1571-1579`.
- `ADMIN-003` Story/reel/bundle/chat-pin server gates are inconsistent with approved-seller policy: `susej-admin-panel/src/app/api/app/**`.
- `ADMIN-004` Public seller endpoint exposes contact fields and auction endpoint exposes bidder identity: `users/[username]/route.ts:79-107`; `auctions/[id]/route.ts:39-54`.

## Runtime evidence log

| Evidence ID | Path | Result | Status |
|---|---|---|---|
| EV-001 | Hosted `POST /api/app/auth/check` for `919442730086` | HTTP 200, `exists:true` | VERIFIED |
| EV-002 | Gradle release build | `BUILD SUCCESSFUL` | VERIFIED |
| EV-003 | Installed package metadata | `versionName=1.1.1`, `versionCode=2` | VERIFIED |
| EV-004 | First install from host artifact | Old `1.1.0` was installed; artifact copy corrected | VERIFIED |
| EV-005 | Foreground dump during an earlier test | `com.instagram.android`; those observations discarded | VERIFIED |
| EV-006 | Clean release auth attempt | Earlier APK returned to auth tree; old bundle lacked post-login grace | VERIFIED FAILURE |
| EV-007 | Patched APK valid OTP `9442730086` | Reached authenticated location onboarding without auth-tree bounce | VERIFIED |
| EV-008 | Logout/relaunch/switch account | Not yet proven | UNVERIFIED |
| EV-009 | CDP admin `/api/data/users?q=9442730086&take=20` | HTTP 200, total 1, active buyer `user0086` | VERIFIED |
| EV-010 | Patched APK artifact | SHA-256 `3334629D3630DAFF083E551851F581F62CACE20CA0C47A483AC4E45B386B6AC9`; version 1.1.1/code 2 | VERIFIED |

## E2E queue

1. Clean install → valid phone OTP → existing account → feed.
2. Clean install → unknown phone → explicit Create Account → OTP → profile → interests → first feed.
3. Wrong OTP → error remains visible; resend cooldown; expired OTP recovery.
4. Logout → guest tree; relaunch remains guest; old token rejected.
5. Account A → Switch Account → B; cart/orders/chat/wallet remain account-scoped.
6. Buyer feed/search/category/PDP/cart/checkout/order/track/review/refund/dispute.
7. Slow DB, offline, timeout, server 500, retry, and cache states.
8. Seller approval, catalog, storefront, orders, payout, auctions, bundles.
9. Admin buyer/seller/order/refund/KYC/report flows with fresh-cookie browser verification.
10. Second zero-finding re-audit pass after fixes.

## Change protocol

- Add a new stable ID for every new module or finding.
- Change state only from `SOURCE_CONFIRMED` to `RUNTIME_VERIFIED` with a named evidence ID.
- Record fixes as `FIXED` only after typecheck/build and real-surface proof.
- Retract a finding when later evidence disproves it; do not silently delete history.
- Keep buyer impact first, then seller/admin root cause.
