import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { usePathname } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../utils/theme';
import { useAuth } from '../contexts/AuthContext';
import { onboardingRouteForStep, replaceRoute } from '../utils/navigation';

// Exact Figma path from splash-screen.svg (node 1:1872, viewBox matches canvas coords)
const ShoppingBagIcon = () => (
  <Svg width={46} height={58} viewBox="177 424 32 40" fill="none">
    <Path
      d="M181.05 464.08C179.95 464.08 179.008 463.688 178.225 462.905C177.441 462.122 177.05 461.18 177.05 460.08V436.08C177.05 434.98 177.441 434.038 178.225 433.255C179.008 432.472 179.95 432.08 181.05 432.08H185.05C185.05 429.88 185.833 427.997 187.4 426.43C188.966 424.863 190.85 424.08 193.05 424.08C195.25 424.08 197.133 424.863 198.7 426.43C200.266 427.997 201.05 429.88 201.05 432.08H205.05C206.15 432.08 207.091 432.472 207.875 433.255C208.658 434.038 209.05 434.98 209.05 436.08V460.08C209.05 461.18 208.658 462.122 207.875 462.905C207.091 463.688 206.15 464.08 205.05 464.08H181.05ZM189.05 432.08H197.05C197.05 430.98 196.658 430.038 195.875 429.255C195.091 428.472 194.15 428.08 193.05 428.08C191.95 428.08 191.008 428.472 190.225 429.255C189.441 430.038 189.05 430.98 189.05 432.08ZM199.05 442.08C199.616 442.08 200.091 441.888 200.475 441.505C200.858 441.122 201.05 440.647 201.05 440.08V436.08H197.05V440.08C197.05 440.647 197.241 441.122 197.625 441.505C198.008 441.888 198.483 442.08 199.05 442.08ZM187.05 442.08C187.616 442.08 188.091 441.888 188.475 441.505C188.858 441.122 189.05 440.647 189.05 440.08V436.08H185.05V440.08C185.05 440.647 185.241 441.122 185.625 441.505C186.008 441.888 186.483 442.08 187.05 442.08Z"
      fill={colors.onPrimaryContainer}
    />
  </Svg>
);

export default function SplashScreen() {
  const { hasOnboarded, isLoggedIn, isLoading, onboardingStep, sessionSeq, guestLanding, user } = useAuth();
  const pathname = usePathname();
  const redirected = useRef(false);
  const [redirectAttempt, setRedirectAttempt] = useState(0);
  const [redirectFailed, setRedirectFailed] = useState(false);
  const initialAuth = useRef<{ hasOnboarded: boolean; isLoggedIn: boolean; onboardingStep: number; sessionSeq: number } | null>(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (pathname !== '/') {
      redirected.current = true;
      return;
    }
    if (isLoading || redirected.current || redirectFailed) return;
    if (!initialAuth.current) {
      initialAuth.current = { hasOnboarded, isLoggedIn, onboardingStep, sessionSeq };
    }
    // A session END is a durable fact, and the guest-landing flag is not: it is
    // committed by the same state update that flips isLoggedIn, so reading it in
    // the same commit can still see the pre-logout value. That race sent a user
    // who had just signed out to the marketing carousel - "it takes me back to
    // the welcome screen" - instead of the sign-in form. If a session existed
    // when this screen first settled, a signed-out state means the session
    // ended, so route to the form on that fact alone and never depend on the
    // flag's timing.
    const sessionEnded =
      initialAuth.current.isLoggedIn === true && !isLoggedIn;
    // A signed-out guest is either brand new (first-run carousel) or a user
    // whose session just ended (logout / switch account / expiry) - the second
    // group must reach the sign-in form, with the expiry notice, never
    // "Get Started" as if they had never seen the app.
    const target = !isLoggedIn
      ? sessionEnded || guestLanding === 'login'
        ? '/login'
        : '/(onboarding)/welcome'
      : hasOnboarded
        ? '/(tabs)/feed'
        : `/(onboarding)/${onboardingRouteForStep(onboardingStep)}`;
    // Cold start gets the brand splash; a mid-session swap (sign-out, account
    // change) already showed the brand, so it must not stall for 2 seconds.
    const sessionSwap = initialAuth.current.isLoggedIn;
    const delay = redirectAttempt !== 0 ? 900 : sessionSwap ? 300 : 2000;
    // The line under the tagline was a static 48x2 bar: gpt vision read it as an
    // ambiguous progress indicator that never moves. It now animates across the
    // EXACT same window the redirect waits for - so it is a truthful indicator,
    // not decoration pretending to be one.
    progressAnim.setValue(0);
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration: delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    const timer = setTimeout(() => {
      if (redirected.current || pathname !== '/') return;
      redirected.current = true;
      void (async () => {
        const navigated = await replaceRoute(target);
        if (navigated) return;
        redirected.current = false;
        if (redirectAttempt === 0) {
          setRedirectAttempt(1);
        } else {
          setRedirectFailed(true);
        }
      })();
    }, delay);
    return () => {
      clearTimeout(timer);
      anim.stop();
    };
  }, [guestLanding, hasOnboarded, isLoggedIn, isLoading, onboardingStep, pathname, redirectAttempt, redirectFailed, sessionSeq]);

  const retryNavigation = () => {
    if (isLoading || pathname !== '/') return;
    setRedirectFailed(false);
    setRedirectAttempt((attempt) => attempt + 1);
  };

  return (
    <View style={styles.root}>
      <StatusBar hidden />

      {/* Background: solid primaryContainer (#5D5FEF) */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.primaryContainer }]} />

      {/* Decorative Ambient Layer */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {/* Pill 1: Soft Tactility Overlay */}
        <View style={styles.pillTop} />
        {/* Pill 2: Background+Blur */}
        <View style={styles.pillBottom} />
        {/* Radial gradient — white center vignette (Figma: paint0_radial_1_1862) */}
        <View style={StyleSheet.absoluteFill}>
          <LinearGradient
            colors={['rgba(255,255,255,0.15)', 'rgba(255,255,255,0)']}
            locations={[0, 0.7]}
            start={{ x: 0.5, y: 0.5 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </View>
      </View>

      {/* Center Content: Brand Logo & Identity */}
      <View style={styles.centerSection}>
        {/* Icon Container with glass effect */}
        <View style={styles.iconOuterWrapper}>
          <View style={styles.iconShadow} />
          <BlurView intensity={24} tint="light" style={styles.iconGlass}>
            <ShoppingBagIcon />
          </BlurView>
        </View>

        {/* Brand Text */}
        <Text style={styles.brandText}>susej</Text>
      </View>

      {/* Bottom Content */}
      <View style={styles.bottomSection}>
        {/* Tagline */}
        <Text style={styles.taglineText}>BUY. SELL. CONNECT.</Text>

        {/* Progress: the fill width IS the redirect timer, so it never lies. */}
        <View style={styles.progressBarTrack}>
          <Animated.View style={[styles.progressBarFill, { width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 72] }) }]} />
        </View>

        {redirectFailed ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={retryNavigation}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Could not open Susej. Tap to retry.</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.primary,
  },

  // ─── Decorative Pills ───
  pillTop: {
    position: 'absolute',
    left: -39,
    top: -212,
    width: 234,
    height: 637,
    borderRadius: 117,
    backgroundColor: '#4343D5',
    opacity: 0.04,
  },
  pillBottom: {
    position: 'absolute',
    left: 195,
    top: 637,
    width: 234,
    height: 637,
    borderRadius: 117,
    backgroundColor: '#696AB5',
    opacity: 0.04,
  },

  // ─── Center Section ───
  // gpt vision pass 1 (-56): the group sat low under a big empty upper area.
  // Pass 2 (-96): that traded the upper void for a LARGER void between the
  // wordmark and the tagline, which is what the second verdict named. -16 sits
  // the group just above true centre: breathing room above the mark, and the
  // tagline no longer stranded at the bottom of a void.
  centerSection: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -16 }],
  },
  iconOuterWrapper: {
    width: 96,
    height: 96,
    borderRadius: 32,
    marginBottom: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 5,
    elevation: 8,
  },
  iconShadow: {
    ...StyleSheet.absoluteFill,
    borderRadius: 32,
    backgroundColor: 'transparent',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 12.5,
    elevation: 12,
  },
  iconGlass: {
    width: 96,
    height: 96,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.20)',
    overflow: 'hidden',
  },
  brandText: {
    fontSize: 34,
    lineHeight: 42,
    letterSpacing: -0.5,
    color: colors.onPrimaryContainer,
    fontFamily: 'Inter',
    fontWeight: '700',
  },

  // ─── Bottom Section (Figma: tagline y~924, progress y=945, card y=971 → card bottom=1029, gap=32px) ───
  bottomSection: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 76,
    alignItems: 'center',
  },
  taglineText: {
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: 5,
    color: colors.onPrimaryContainer,
    fontFamily: 'Inter',
    fontWeight: '400',
    marginBottom: 3,
  },

  // Progress bar (Figma: 48w x 2h, rx=1, y=945)
  progressBarTrack: {
    width: 72,
    height: 3,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.28)',
    overflow: 'hidden',
    marginBottom: 0,
  },
  progressBarFill: {
    width: 72,
    height: 3,
    borderRadius: 1,
    backgroundColor: colors.onPrimaryContainer,
  },
  retryButton: {
    marginTop: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  retryText: {
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.14,
    textAlign: 'center',
    color: colors.onPrimaryContainer,
    fontFamily: 'Inter',
    fontWeight: '600',
  },

});