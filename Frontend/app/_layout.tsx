import '../global.css';
import { Stack, usePathname } from 'expo-router';
import { LogBox } from 'react-native';
// Benign device-capability notice. In dev it raised a LogBox overlay that sat
// ON TOP of the auth screens and swallowed taps, which is both a bad developer
// experience and a misleading test signal (a screen that looks unresponsive).
LogBox.ignoreLogs(['Reduced motion setting is enabled on this device']);
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform, StyleSheet, View, Text, ActivityIndicator } from 'react-native';
// react-native-web throws "Cannot manually set color scheme" unless darkMode flag is 'class'.
// Expo's web bootstrap sets data-color-scheme; this flag makes manual scheme setting legal.
if (Platform.OS === 'web') {
  try {
    // setFlag is an undocumented RN-internal API — cast for TS
    (StyleSheet as unknown as { setFlag: (flag: string, value: string) => void }).setFlag('darkMode', 'class');
  } catch {}
}
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, useRef, Component, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { applyTheme, AppearanceContext, THEME_STORAGE_KEY, colors, type ThemeMode } from '../utils/theme';
import { useAuth } from '../contexts/AuthContext';
import { setLocale, LOCALE_STORAGE_KEY } from '../utils/i18n';
import { AuthProvider } from '../contexts/AuthContext';
import { FollowProvider } from '../contexts/FollowContext';
import { BookmarkProvider } from '../contexts/BookmarkContext';
import { PostProvider } from '../contexts/PostContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { CartProvider } from '../contexts/CartContext';
import { OrderProvider } from '../contexts/OrderContext';
import { CommunityProvider } from '../contexts/CommunityContext';
import { RecentlyViewedProvider } from '../contexts/RecentlyViewedContext';
import { HashtagProvider } from '../contexts/HashtagContext';
import { PromotionProvider } from '../contexts/PromotionContext';
import { OfflineBanner } from '../components/OfflineBanner';
import { serverApi } from '../utils/serverApi';
import { normalizeRoutePath, onboardingRouteForStep, publishPathname, replaceRoute } from '../utils/navigation';
import { trace } from '../utils/trace';

SplashScreen.preventAutoHideAsync();

/**
 * Feeds the router's real pathname to utils/navigation so replaceRoute() can
 * VERIFY that a dispatch actually opened the intended screen instead of
 * reporting success on "did not throw".
 *
 * Mounted HERE, unconditionally, rather than inside SessionDataTree. It used to
 * live in each branch of that tree, which returns a bare skeleton while
 * `isLoading` - so during boot (exactly when the session tree swaps and a
 * redirect is most likely) no pathname was ever published, every replaceRoute
 * reported FAILED, and the retry path spun until React aborted the tree with
 * "Maximum update depth exceeded". One always-on mirror removes that whole
 * class of failure, and living above both navigators means a session swap
 * cannot leave the verifier reading a retired path.
 */
function PathnameMirror() {
  const pathname = usePathname();
  useEffect(() => {
    publishPathname(pathname);
    trace('pathname', pathname);
  }, [pathname]);
  return null;
}

/**
 * Surfaces that only exist for a signed-out visitor, and vice versa. Group
 * segments are stripped, so '/(onboarding)/otp' and '/otp' are one leaf.
 */
const GUEST_LEAVES = new Set(['/', '/login', '/welcome', '/auth', '/otp']);
const SESSION_ROUTE_ATTEMPTS = 3;
const SESSION_ROUTE_RETRY_MS = 400;

/**
 * Redirect budget per session transition, held at MODULE scope on purpose.
 * As component refs it reset to 1 every time the tree remounted, so a failing
 * boundary redirect retried forever and drove React into "Maximum update depth
 * exceeded" - the tree was being torn down and rebuilt underneath the gate.
 * A module-level counter survives the remount, so the bound is real.
 */
const routeBudgets = new Map<string, number>();
function takeRouteBudget(key: string): boolean {
  const used = routeBudgets.get(key) ?? 0;
  if (used >= SESSION_ROUTE_ATTEMPTS) return false;
  routeBudgets.set(key, used + 1);
  return true;
}
function clearRouteBudget(key: string): void {
  routeBudgets.delete(key);
}

/**
 * The ONE actor for session-boundary navigation.
 *
 * Flipping isLoggedIn swaps the whole navigator tree, but the router KEEPS the
 * live pathname, so the surface under the user belongs to the side they just
 * left: after a successful OTP the sign-in screen stayed mounted inside the
 * authenticated tree (a fresh, empty form the user can never leave - the auth
 * tree loop), and after logout/switch-account the authenticated path survived
 * into a guest tree (a blank window). A key change on the navigator does not
 * clear the path, so the boundary has to route explicitly.
 *
 * Fires once per session sequence, only when the live path is on the wrong
 * side, and stops after a bounded number of unverified dispatches so a failed
 * navigation can never become a ping-pong.
 */
function SessionRouteGate() {
  const { isLoading, isLoggedIn, hasOnboarded, onboardingStep, sessionSeq, guestLanding, user } =
    useAuth();
  const pathname = usePathname();
  const handled = useRef<string | null>(null);
  // A retry has to change STATE to re-enter this effect. Clearing the handled
  // ref alone never did: with no dependency changing, the effect simply did not
  // run again, so the single dispatch had exactly one chance.
  const [retryTick, setRetryTick] = useState(0);
  // A profile picture is mandatory, so a signed-in account without one belongs
  // in profile-setup regardless of the onboarded flag. The root gate is the
  // only actor that can enforce this from OUTSIDE the onboarding group (the
  // group's own layout is not mounted while the user is on the feed), and the
  // group's layout agrees with this target - the two used to disagree, which is
  // what produced a profile-setup <-> feed ping-pong.
  const hasAvatar = Boolean(user?.avatar?.trim());
  // Dispatch the BARE leaf, not the group-qualified href. `/(onboarding)/x`
  // from inside `(tabs)` is the form that silently no-ops against a keyed root
  // Stack - the dispatch lands nowhere and the retry budget burns out. The
  // leaf resolves to the same screen (profile-setup only exists in the
  // group) and normalizeRoutePath() verifies the two forms identically.
  const target = isLoggedIn
    ? !hasAvatar
      ? '/profile-setup'
      : hasOnboarded
        ? '/feed'
        : `/${onboardingRouteForStep(onboardingStep)}`
    : guestLanding === 'login'
      ? '/login'
      : '/welcome';
  const leaf = normalizeRoutePath(pathname);
  // '/' is deliberately excluded on the way in: that route IS the splash, and
  // it already routes itself with the brand moment attached. The gate only
  // rescues the surfaces that would otherwise survive the tree swap.
  //
  // The one signed-out exception is the welcome carousel itself: '/welcome' is
  // a legal guest leaf, so a session that died WHILE the carousel was mounted
  // (expiry, logout, switch account) left the user sitting there being offered
  // "Get Started" as if they had never seen the app, with the expiry notice
  // never shown and no path to the sign-in form.
  const wrongSide = isLoggedIn
    ? (GUEST_LEAVES.has(leaf) && leaf !== '/') ||
      (!hasAvatar && leaf !== '/profile-setup')
    : !GUEST_LEAVES.has(leaf) || (leaf === '/welcome' && guestLanding === 'login');
  // The latched surface is part of the identity: a transition latched on
  // sessionSeq alone never re-armed for a wrong-side path the user REVISITED
  // (the authed stack still contains /(onboarding), so hardware back can walk a
  // signed-in user onto /otp or /auth - and the gate then refused to route).
  const transition = `${isLoggedIn ? 'in' : 'out'}:${sessionSeq}:${leaf}`;

  useEffect(() => {
    if (isLoading) return;
    if (handled.current === transition) return;
    if (!wrongSide) {
      handled.current = transition;
      clearRouteBudget(transition);
      return;
    }
    // The retry budget belongs to THIS transition: a shared counter would
    // exhaust itself across a long session and silently stop routing, leaving
    // the user on a surface that belongs to the side they left.
    if (!takeRouteBudget(transition)) {
      trace('session-route-gate GAVE UP', { transition, from: pathname, target });
      return;
    }
    handled.current = transition;
    void (async () => {
      const navigated = await replaceRoute(target);
      trace('session-route-gate', {
        transition,
        direction: isLoggedIn ? 'in' : 'out',
        from: pathname,
        target,
        navigated,
      });
      if (navigated) {
        clearRouteBudget(transition);
        return;
      }
      // Only re-arm THIS transition. Clearing the latch unconditionally let a
      // slow failure from an earlier transition unlock a later one's latch, so
      // two dispatches could overlap and a stale target could land after the
      // user had already moved on.
      if (handled.current !== transition) return;
      handled.current = null;
      // Space the retries out. Re-entering the effect on the same tick is what
      // turned one unverified dispatch into an unbounded loop.
      setTimeout(() => setRetryTick((value) => value + 1), SESSION_ROUTE_RETRY_MS);
    })();
  }, [isLoading, isLoggedIn, pathname, retryTick, target, transition, wrongSide]);

  return null;
}

/**
 * Root crash boundary (industry standard): ANY render crash anywhere in the
 * app lands here with the error NAMED on screen + restart — never a dead
 * blank window. Added to diagnose the post-logout blank: whatever throws on
 * the session flip names itself instead of vanishing.
 */
class RootCrashBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    try {
      // eslint-disable-next-line no-console
      console.error('[root-crash]', error?.message, error?.stack);
    } catch {}
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: '#1a1a2e', textAlign: 'center', marginBottom: 8 }}>
          Something went wrong
        </Text>
        <Text style={{ fontSize: 12, color: '#464555', textAlign: 'center', marginBottom: 4 }}>
          The app hit an error. Restart to continue.
        </Text>
        <Text style={{ fontSize: 10, color: '#8a8899', textAlign: 'center' }}>
          {String(error?.message ?? error).slice(0, 300)}
        </Text>
      </View>
    );
  }
}

/**
 * Boundary-proof root navigator (industry standard: Instagram/WhatsApp).
 * Logged-in renders the FULL app; logged-out renders ONLY index/login/
 * onboarding. Logout/login flips isLoggedIn and React swaps the whole tree
 * — authed screens UNMOUNT, so back can never reach them and no navigation
 * call exists to race or corrupt (the entire dismissAll/replace/dismissTo
 * blue-screen class is structurally impossible). Guards that used to
 * navigate are render-only nulls now.
 */
function LaunchSkeleton() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceContainerLowest, paddingHorizontal: 20, paddingTop: 28 }}>
      <View style={{ width: 116, height: 18, borderRadius: 9, backgroundColor: colors.surfaceContainer }} />
      <View style={{ width: '100%', height: 168, borderRadius: 18, marginTop: 22, backgroundColor: colors.surfaceContainer }} />
      <View style={{ width: '72%', height: 14, borderRadius: 7, marginTop: 20, backgroundColor: colors.surfaceContainer }} />
      <View style={{ width: '88%', height: 14, borderRadius: 7, marginTop: 10, backgroundColor: colors.surfaceContainer }} />
      <View style={{ width: '100%', height: 74, borderRadius: 16, marginTop: 24, backgroundColor: colors.surfaceContainer }} />
    </View>
  );
}

function PublicReadWarmup() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void Promise.allSettled([
      serverApi.getCategories(),
      serverApi.getHome(),
      serverApi.getStories(),
      serverApi.getPromotions(),
    ]);
  }, []);
  return null;
}

function AuthenticatedReadWarmup() {
  const { user, tokenSeq } = useAuth();
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    const username = user?.username?.trim();
    const key = username ? `${username}:${tokenSeq}` : null;
    if (!key || startedFor.current === key) return;
     startedFor.current = key;
     void serverApi.getNotifications();
     void serverApi.getFollows();
  }, [tokenSeq, user?.username]);
  return null;
}

function SessionDataTree() {
  const { isLoading, isLoggedIn, sessionSeq, tokenSeq } = useAuth();
  const navigatorKey = `${isLoggedIn ? 'auth' : 'guest'}:${sessionSeq}`;
  trace('SessionDataTree', { navigatorKey, tokenSeq, isLoading });
  if (isLoading) return <LaunchSkeleton />;
  // The provider stack is mounted for BOTH session states. Signing out used to
  // swap in a bare navigator, but the router can still resolve a consumer route
  // (/profile, /feed, ...) for a moment during the swap, and a screen calling
  // usePosts() with no PostProvider above it THREW - so every logout ended on a
  // red "Something went wrong" screen. Contexts are inert without a session:
  // they read the cache, fail soft, and reset on the next keyed remount.
  return (
    <FollowProvider key={navigatorKey}>
      <BookmarkProvider>
        <PostProvider>
          {isLoggedIn ? <AuthenticatedReadWarmup /> : null}
          <SettingsProvider>
            <NotificationProvider>
              <CartProvider>
                <OrderProvider>
                  <CommunityProvider>
                    <RecentlyViewedProvider>
                      <HashtagProvider>
                         <PromotionProvider>
                           <OfflineBanner />
                           <RootNavigator key={navigatorKey} />
                         </PromotionProvider>
                      </HashtagProvider>
                    </RecentlyViewedProvider>
                  </CommunityProvider>
                </OrderProvider>
              </CartProvider>
            </NotificationProvider>
          </SettingsProvider>
        </PostProvider>
      </BookmarkProvider>
    </FollowProvider>
  );
}

function RootNavigator() {
  const { isLoggedIn, isLoading, sessionSeq, hasOnboarded } = useAuth();
  const navigatorKey = `${isLoggedIn ? 'auth' : 'guest'}:${sessionSeq}`;

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceContainerLowest }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!isLoggedIn) {
    return (
      <Stack key={navigatorKey} screenOptions={{ headerShown: false }} initialRouteName="index">
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="(onboarding)" />
      </Stack>
    );
  }

  return (
    <Stack
      key={navigatorKey}
      screenOptions={{ headerShown: false }}
      initialRouteName={hasOnboarded ? '(tabs)' : '(onboarding)'}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="(onboarding)" />
    </Stack>
  );
}

export default function RootLayout() {
  useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  const [themeMode, setThemeMode] = useState<ThemeMode>('light');

  useEffect(() => {
    (async () => {
      try {
        const storedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
        if (storedTheme === 'dark' || storedTheme === 'light') {
          setThemeMode(storedTheme);
        }
        const storedLocale = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
        if (storedLocale === 'en' || storedLocale === 'hi') {
          setLocale(storedLocale);
        }
      } catch {
        // storage unavailable — defaults are fine
      }
    })();
  }, []);

  useEffect(() => {
    applyTheme(themeMode);
  }, [themeMode]);

  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppearanceContext.Provider value={{ themeMode, setThemeMode }}>
          <RootCrashBoundary>
            <AuthProvider>
              <PublicReadWarmup />
              <StatusBar style={themeMode === 'dark' ? 'light' : 'dark'} />
              <PathnameMirror />
              <SessionRouteGate />
              <SessionDataTree />
            </AuthProvider>
          </RootCrashBoundary>
        </AppearanceContext.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
