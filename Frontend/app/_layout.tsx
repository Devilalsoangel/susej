import '../global.css';
import { Stack, router } from 'expo-router';
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

SplashScreen.preventAutoHideAsync();

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

function SessionDataTree() {
  const { isLoading, isLoggedIn } = useAuth();
  if (isLoading) return <LaunchSkeleton />;
  if (!isLoggedIn) return <RootNavigator />;
  return (
    <FollowProvider>
      <BookmarkProvider>
        <PostProvider>
          <SettingsProvider>
            <NotificationProvider>
              <CartProvider>
                <OrderProvider>
                  <CommunityProvider>
                    <RecentlyViewedProvider>
                      <HashtagProvider>
                        <PromotionProvider>
                          <OfflineBanner />
                          <RootNavigator />
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
  const authBoundary = useRef<{ hasOnboarded: boolean; isLoggedIn: boolean; sessionSeq: number } | null>(null);

  useEffect(() => {
    if (isLoading) return;
    const previous = authBoundary.current;
    const current = { hasOnboarded, isLoggedIn, sessionSeq };
    authBoundary.current = current;
    if (!previous) return;
    if (
      previous.hasOnboarded === current.hasOnboarded &&
      previous.isLoggedIn === current.isLoggedIn &&
      previous.sessionSeq === current.sessionSeq
    ) {
      return;
    }
    const target = !isLoggedIn
      ? '/login'
      : hasOnboarded
        ? '/(tabs)/feed'
        : '/(onboarding)/location';
    const timer = setTimeout(() => router.replace(target), 0);
    return () => clearTimeout(timer);
  }, [hasOnboarded, isLoading, isLoggedIn, sessionSeq]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceContainerLowest }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!isLoggedIn) {
    return (
      <Stack key={navigatorKey} screenOptions={{ headerShown: false }} initialRouteName="login">
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
    />
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
              <SessionDataTree />
            </AuthProvider>
          </RootCrashBoundary>
        </AppearanceContext.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
