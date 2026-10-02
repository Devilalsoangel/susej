import { router } from 'expo-router';

const ONBOARDING_STEP_ROUTES = [
  'profile-setup',
  'location',
  'interests',
  'first-feed',
] as const;

export type OnboardingRoute = (typeof ONBOARDING_STEP_ROUTES)[number];

export function normalizeOnboardingStep(step: number): 1 | 2 | 3 | 4 {
  if (!Number.isFinite(step)) return 1;
  return Math.min(4, Math.max(1, Math.trunc(step))) as 1 | 2 | 3 | 4;
}

export function onboardingRouteForStep(step: number): OnboardingRoute {
  return ONBOARDING_STEP_ROUTES[normalizeOnboardingStep(step) - 1];
}

export function onboardingStepForRoute(route: string): 1 | 2 | 3 | 4 | null {
  const index = ONBOARDING_STEP_ROUTES.indexOf(route as OnboardingRoute);
  return index < 0 ? null : ((index + 1) as 1 | 2 | 3 | 4);
}

/**
 * VERIFIED navigation (industry standard: a navigation promise means something).
 *
 * expo-router's imperative replace() is fire-and-forget: it never rejects and
 * can silently no-op (target not mounted, a layout guard intervened, the
 * navigator was mid-swap). "Did not throw" was therefore never proof that the
 * intended surface opened, and every forward step in the auth/onboarding
 * funnel gates its latch on this result - a caller that believes a failed
 * advance succeeded stays latched forever (a permanently dead Continue
 * button). Success is now only reported once the router's own pathname proves
 * the intended route is the live surface.
 */
const VERIFY_TIMEOUT_MS = 700;
const VERIFY_POLL_MS = 40;
const VERIFY_RETRY_MS = 350;

let observedPathname: string | null = null;

/**
 * Root-layout bridge (see PathnameMirror in app/_layout.tsx): keeps the
 * verifier fed with the router's real pathname. Publishing null on unmount
 * retires a stale value from the previous navigator so it can never be used to
 * "prove" a navigation landed.
 */
export function publishPathname(pathname: string | null | undefined): void {
  const next =
    typeof pathname === 'string' && pathname.length > 0 ? pathname : null;
  if (observedPathname === next) return;
  observedPathname = next;
}

export function getObservedPathname(): string | null {
  return observedPathname;
}

/**
 * Group segments are organisational only: `/(tabs)/feed` and `/feed` are the
 * same screen, while query params never identify a screen. Comparing the
 * normalized leaf keeps verification honest without failing on a legal
 * group-qualified href.
 */
export function normalizeRoutePath(path: string): string {
  const [pathname] = String(path ?? '').split(/[?#]/);
  const segments = pathname
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\(.+\)$/.test(segment));
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function isTargetPathname(actual: string, target: string): boolean {
  return normalizeRoutePath(actual) === normalizeRoutePath(target);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function replaceRoute(href: string, attempt = 0): Promise<boolean> {
  const target = String(href ?? '');
  if (!target) return false;
  try {
    await Promise.resolve(router.replace(target as never));
  } catch {
    return false;
  }
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  for (;;) {
    const actual = observedPathname;
    if (actual !== null && isTargetPathname(actual, target)) {
      if (__DEV__) console.log(`[nav] replace ${target} VERIFIED (path=${actual})`);
      return true;
    }
    if (Date.now() >= deadline) break;
    await wait(VERIFY_POLL_MS);
  }
  if (__DEV__)
    console.log(
      `[nav] replace ${target} FAILED (lastPath=${String(observedPathname)}${attempt > 0 ? ', retry' : ''})`
    );
  // A navigation the pathname never confirmed is UNKNOWN - not success.
  // Reporting "true" when nothing was ever observed is exactly the
  // "did not throw = it navigated" lie this function exists to kill: it let a
  // swallowed boundary redirect look like a successful one, so a session swap
  // silently left the user on the screen belonging to the side they left.
  // Re-dispatch once - a replace eaten by a concurrent navigator swap lands on
  // the retry - and re-verify. Still unconfirmed means FAILURE.
  if (attempt < 1) {
    await wait(VERIFY_RETRY_MS);
    return replaceRoute(href, attempt + 1);
  }
  return false;
}

/**
 * History-aware back (Instagram deep-link norm): cold-start and shared-link
 * entries have an empty nav stack, where a bare router.back() is a dead tap
 * that strands the user (kill-the-app to escape). Falls back to a real
 * surface only when there is no history - in-flow backs behave identically.
 */
export function goBack(fallback: string = '/feed'): void {
  try {
    if (router.canGoBack()) {
      router.back();
      return;
    }
  } catch {}
  try {
    router.replace(fallback as never);
  } catch {}
}
