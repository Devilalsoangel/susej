import { useEffect, useRef, useState } from 'react';
import { Stack, usePathname } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import {
  onboardingRouteForStep,
  onboardingStepForRoute,
  replaceRoute,
} from '../../utils/navigation';

const PUBLIC_ROUTES = new Set(['welcome', 'auth', 'otp']);
const PROTECTED_ROUTES = new Set(['profile-setup', 'location', 'interests', 'first-feed']);
const MAX_REDIRECT_ATTEMPTS = 3;

function currentRoute(pathname: string): string {
  // '/' is the splash route, not a step of this funnel. Folding it into
  // 'welcome' made this guard claim a surface the splash already owns, so two
  // actors routed the same path; the splash keeps '/' to itself.
  if (!pathname || pathname === '/') return '';
  return pathname
    .replace(/^\/\(onboarding\)\/?/, '')
    .replace(/^\/|\/$/g, '') || 'welcome';
}

export default function OnboardingLayout() {
  const { isLoading, isLoggedIn, hasOnboarded, onboardingStep, guestLanding, user } = useAuth();
  const pathname = usePathname();
  // Latched per ROUTE->TARGET transition, not for the life of the layout. The
  // old single boolean was set on the first dispatch and never cleared on
  // success, so `if (redirecting.current) return;` silently killed this guard
  // for every later transition - the second redirect of a session was simply
  // dropped and the user was left stranded on the wrong step.
  const dispatched = useRef<string | null>(null);
  const [redirectAttempt, setRedirectAttempt] = useState(0);
  const route = currentRoute(pathname);
  const routeStep = onboardingStepForRoute(route);
  const entryRoute = onboardingRouteForStep(onboardingStep);
  const initialRouteName = !isLoggedIn ? 'welcome' : entryRoute;
  // A profile picture is mandatory during setup (profile-setup hides Continue
  // without one). It is NOT enforced as a navigation rule here: expo-router
  // restores the live pathname across a keyed remount, so an existing account
  // already sitting on /feed could not be pulled back into setup - the rule
  // only produced a guard fight that locked navigation.
  const hasAvatar = Boolean(user?.avatar?.trim());
  void hasAvatar;

  useEffect(() => {
    if (isLoading) return;

    let target: string | null = null;
    if (PROTECTED_ROUTES.has(route) && !isLoggedIn) {
      // A signed-out user belongs on the sign-in form if their session just
      // ended, and on the first-run carousel only if they are brand new.
      target = guestLanding === 'login' ? '/login' : '/(onboarding)/welcome';
    } else if (isLoggedIn && !hasAvatar && route !== 'profile-setup') {
      // A profile picture is mandatory, so profile-setup is the ONLY route an
      // account without one may occupy - public onboarding routes included.
      // This branch is the single owner of that rule, and it must run BEFORE
      // the hasOnboarded rules below: leaving the feed rule unguarded made it
      // fire the moment the user arrived on profile-setup, and the root gate
      // pushed them straight back, which is the ping-pong the user saw.
      target = '/(onboarding)/profile-setup';
    } else if (PUBLIC_ROUTES.has(route) && isLoggedIn) {
      target = hasOnboarded ? '/(tabs)/feed' : `/(onboarding)/${entryRoute}`;
    } else if (
      PROTECTED_ROUTES.has(route) &&
      isLoggedIn &&
      hasOnboarded &&
      hasAvatar &&
      route !== 'first-feed'
    ) {
      target = '/(tabs)/feed';
    } else if (
      PROTECTED_ROUTES.has(route) &&
      isLoggedIn &&
      !hasOnboarded &&
      routeStep !== null &&
      routeStep > onboardingStep
    ) {
      target = `/(onboarding)/${entryRoute}`;
    }

    if (!target) {
      dispatched.current = null;
      return;
    }
    const transition = `${route}->${target}`;
    if (dispatched.current === transition) return;
    // This layout is the ONLY navigation actor for the onboarding tree. A
    // dispatch that could not be verified is retried a bounded number of
    // times, then the guard stops pushing: the protected screens themselves
    // render null while signed out, so stopping here fails closed instead of
    // looping the user between two screens.
    if (redirectAttempt >= MAX_REDIRECT_ATTEMPTS) return;
    dispatched.current = transition;
    void (async () => {
      const navigated = await replaceRoute(target as string);
      if (navigated) {
        setRedirectAttempt(0);
        return;
      }
      dispatched.current = null;
      setRedirectAttempt((attempt) => attempt + 1);
    })();
  }, [
    entryRoute,
    guestLanding,
    hasAvatar,
    hasOnboarded,
    isLoading,
    isLoggedIn,
    onboardingStep,
    redirectAttempt,
    route,
    routeStep,
  ]);

  return (
    <Stack
      initialRouteName={initialRouteName}
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="welcome" />
      <Stack.Screen name="auth" options={{ gestureEnabled: false }} />
      <Stack.Screen name="otp" />
      <Stack.Screen name="profile-setup" options={{ gestureEnabled: false }} />
      <Stack.Screen name="location" options={{ gestureEnabled: false }} />
      <Stack.Screen name="interests" options={{ gestureEnabled: false }} />
      <Stack.Screen name="first-feed" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
