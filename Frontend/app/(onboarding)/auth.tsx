import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Image, Dimensions, StyleSheet, BackHandler, Modal, TextInput, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as AuthSession from 'expo-auth-session';
import Constants from 'expo-constants';
import { GoogleIcon, PhoneIcon, ChevronLeftIcon } from '../../utils/icons';
import { colors } from '../../utils/theme';
import { authImages, authImageUrls } from '../../utils/screenImages';
import { useAuth } from '../../contexts/AuthContext';
import { replaceRoute } from '../../utils/navigation';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const BENTO_GAP = 12;
const BENTO_LEFT_W = 166;
const BENTO_RIGHT_W = 170;
const BENTO_W = BENTO_LEFT_W + BENTO_GAP + BENTO_RIGHT_W; // 348
const BENTO_H = 251; // portrait height from Figma

export default function AuthScreen() {
  const { serverGoogleLogin } = useAuth();
  const [googleError, setGoogleError] = useState('');
  const [navError, setNavError] = useState('');
  const [devModalVisible, setDevModalVisible] = useState(false);
  const [devEmail, setDevEmail] = useState('');
  const navigating = useRef(false);
  const [busy, setBusy] = useState(false);
  // Hosted art first (~600KB of PNG has no business in the JS bundle), bundled
  // copy as the offline fallback.
  const bentoSource = (i: number) => {
    const url = authImageUrls[i];
    return url ? { uri: url } : authImages[i];
  };

  // Verified dispatch: expo-router's replace() never rejects, so success is
  // only claimed once the router's pathname proves the target opened. A
  // failed advance re-arms the latch, otherwise one silent no-op leaves every
  // button on this screen permanently dead.
  const go = async (target: string) => {
    if (navigating.current) return;
    navigating.current = true;
    // `navigating` is a REF, so `disabled={navigating.current}` never re-rendered
    // and the button stayed ENABLED for the whole flight - a slow replace looked
    // like a dead tap and invited the double-tap the ref then had to swallow.
    // A state flag is what actually disables the control.
    setBusy(true);
    setNavError('');
    const navigated = await replaceRoute(target);
    if (navigated) return;
    navigating.current = false;
    setBusy(false);
    setNavError('Could not open that screen. Please try again.');
  };

  const goBack = () => {
    void go('/(onboarding)/welcome');
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  const googleClientId = (Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.googleClientId as string | undefined ?? '';
  const redirectUri = AuthSession.makeRedirectUri({ native: 'susej://auth/google' } as Parameters<typeof AuthSession.makeRedirectUri>[0]);

  const [, response] = AuthSession.useAuthRequest(
    {
      clientId: googleClientId,
      scopes: ['openid', 'email', 'profile'],
      redirectUri,
      responseType: AuthSession.ResponseType.IdToken,
    },
    { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth' } as unknown as Parameters<typeof AuthSession.useAuthRequest>[1]
  );

  useEffect(() => {
    if (!response) return;
    if (response.type === 'success') {
      const idToken = (response.params as Record<string, string | undefined>)?.id_token;
      if (!idToken) {
        setGoogleError('Google sign-in failed. Try again.');
        return;
      }
      setGoogleError('');
      serverGoogleLogin(idToken)
        .then((res) => {
          if (res.ok) return;
          setGoogleError(res.error ?? 'Google sign-in failed. Try again.');
        });
    } else if (response.type === 'error') {
      setGoogleError((response.error as { message?: string } | undefined)?.message ?? 'Google sign-in failed. Try again.');
    }
  }, [response, serverGoogleLogin]);

  const handleDevBypass = async () => {
    const email = devEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setGoogleError('Enter a valid email address');
      return;
    }
    setDevModalVisible(false);
    setGoogleError('');
    const res = await serverGoogleLogin('', { email, name: email.split('@')[0] });
    if (res.ok) return;
    setGoogleError(res.error ?? 'Dev Google sign-in failed.');
  };

  // Dev bypass must never appear in user hands: __DEV__ is true in every
  // debug APK, so it additionally requires an explicit local opt-in that is
  // gitignored (.env.local) and never set for builds leaving this machine.
  const showDevBypass =
    __DEV__ && !googleClientId && process.env.EXPO_PUBLIC_DEV_BYPASS === '1';

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.topBlur} pointerEvents="none" />

      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        {/* P0: this screen's content is taller than a 1080x2400 viewport, and it
            was NOT scrollable - so "Already have an account? Log in" rendered
            below the fold (verified: absent from the uiautomator tree, legal row
            ending at y=2299 of 2400). A returning user had NO sign-in path.
            Every entry screen scrolls when content exceeds the viewport. */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
        <View style={styles.topBar}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.7}
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <ChevronLeftIcon size={18} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.headerSection}>
          <Text style={styles.logo} accessibilityRole="header">susej</Text>
          <Text style={styles.welcomeTitle} accessibilityRole="header">Buy &amp; sell nearby</Text>
          <View style={styles.subtitleWrapper}>
            {/* gpt vision: the supporting line originally read like a LUXURY
                FASHION RETAILER ("most exclusive curated collections"), and
                "Welcome to susej" was generic filler while the copy did the real
                work. The headline now carries the proposition. */}
            <Text style={styles.subtitle}>
              Post a product in seconds, or find what your neighbourhood is selling.
            </Text>
          </View>
        </View>

        <View style={styles.heroSection}>
          <View style={styles.abstractVisual} pointerEvents="none" accessible={false} importantForAccessibility="no" />

          {/* One coherent illustration, not a collage of three stock-looking
              tiles. gpt vision: "the woman, phone screenshot and interior do not
              form a coherent story" and the block "consumes a lot of vertical
              space for relatively little communication". */}
          <View style={styles.bentoGrid} accessible={false} importantForAccessibility="no-hide-descendants">
            <Image source={bentoSource(0)} style={styles.authHero} resizeMode="cover" />
          </View>
        </View>

        <View style={styles.footerSection}>
          <TouchableOpacity
            style={[styles.primaryButton, busy && styles.primaryButtonBusy]}
            activeOpacity={0.8}
            onPress={() => { void go('/(onboarding)/otp'); }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Continue with Phone"
            accessibilityState={{ busy, disabled: busy }}
          >
            <PhoneIcon size={14} color="#FFFFFF" />
            <Text style={styles.buttonTextWhite}>Continue with Phone</Text>
          </TouchableOpacity>

          {/* Google sign-in is not wired: there is no Google client id in the
              build config, so the row was a View with no onPress at all - a dead
              tap that looked like a broken app. It is now honestly disabled and
              says why, instead of pretending to be tappable.
              gpt vision: the row was also "a little too visually prominent for a
              disabled option" - the outlined container occupied a lot of space -
              so it is quieter (opacity 0.42, 44dp, tighter padding). */}
          <View
            accessibilityRole="text"
            accessibilityLabel="Google sign-in, coming soon"
            style={[styles.secondaryButton, { opacity: 0.42, paddingVertical: 10, minHeight: 44 }]}
          >
            <GoogleIcon size={20} />
            <Text style={styles.buttonTextDark}>Google sign-in</Text>
            <View style={styles.soonChip}>
              <Text style={styles.soonText}>SOON</Text>
            </View>
          </View>

          {googleError || navError ? (
            <Text style={styles.errorText}>{googleError || navError}</Text>
          ) : null}

            {/* The legal links are STANDALONE 44dp controls, not inline text.
                An inline <Text onPress> inside another <Text> measured 24dp on
                a real device - and paddingVertical does NOT grow an inline
                child's accessibility bounds, so the target stayed small. */}
            <Text style={styles.termsText}>By continuing, you agree to susej's</Text>
            <View style={styles.termsRow}>
              <TouchableOpacity
                style={styles.termsLinkBtn}
                onPress={() => router.push('/terms')}
                accessibilityRole="link"
                accessibilityLabel="Terms of Service"
              >
                <Text style={styles.termsLink}>Terms of Service</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.termsLinkBtn}
                onPress={() => router.push('/privacy')}
                accessibilityRole="link"
                accessibilityLabel="Privacy Policy"
              >
                <Text style={styles.termsLink}>Privacy Policy</Text>
              </TouchableOpacity>
            </View>

          <TouchableOpacity
            style={styles.loginButton}
            activeOpacity={0.8}
            onPress={() => { void go('/login'); }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Already have an account? Log in"
            accessibilityState={{ disabled: busy }}
          >
            <Text style={styles.loginButtonText}>
              Already have an account? <Text style={{ fontWeight: '700', color: colors.primary }}>Log in</Text>
            </Text>
          </TouchableOpacity>
        </View>
        </ScrollView>
      </SafeAreaView>

      <Modal visible={devModalVisible} transparent animationType="fade" onRequestClose={() => { setDevModalVisible(false); setGoogleError(''); }}>
        <View style={styles.devModalOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => { setDevModalVisible(false); setGoogleError(''); }} />
          <View style={styles.devModalCard}>
            <Text style={styles.devModalTitle}>Dev Google bypass</Text>
            <Text style={styles.devModalSubtitle}>Enter an email to create or sign in as that Google user.</Text>
            <TextInput
              style={styles.devInput}
              placeholder="g.tester@susej.dev"
              placeholderTextColor="rgba(70,69,85,0.4)"
              value={devEmail}
              onChangeText={setDevEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.devModalRow}>
              <TouchableOpacity style={styles.devCancelBtn} onPress={() => { setDevModalVisible(false); setGoogleError(''); }}>
                <Text style={styles.devCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.devConfirmBtn} onPress={handleDevBypass}>
                <Text style={styles.devConfirmText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surfaceContainerLowest,
  },

  topBlur: {
    position: 'absolute',
    left: -64,
    top: -64,
    width: 192,
    height: 192,
    borderRadius: 96,
    backgroundColor: colors.primaryFixedDim,
    opacity: 0.3,
    zIndex: -1,
  },

  safeArea: {
    flex: 1,
  },

  topBar: {
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },

    backButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },

  headerSection: {
    alignItems: 'center',
    paddingTop: 4,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },

  logo: {
    fontFamily: 'Inter',
    fontSize: 40,
    lineHeight: 48,
    color: colors.primary,
    fontWeight: '400',
    textAlign: 'center',
  },

  welcomeTitle: {
    fontFamily: 'Inter',
    fontSize: 20,
    lineHeight: 28,
    color: colors.textPrimary,
    fontWeight: '400',
    textAlign: 'center',
    marginTop: 12,
  },

  subtitleWrapper: {
    width: 280,
    marginTop: 12,
  },

  subtitle: {
    fontFamily: 'Inter',
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    textAlign: 'center',
    fontWeight: '400',
  },

  heroSection: {
    flex: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // Was flex:1 - the hero ate every spare pixel and left the lower block
  // heavier than the top (gpt vision). A bounded box tightens the rhythm.

  abstractVisual: {
    ...StyleSheet.absoluteFill,
    opacity: 0.1,
    overflow: 'hidden',
  },

  blurCircle: {
    position: 'absolute',
    left: -55,
    top: 8,
    width: 500,
    height: 500,
    borderRadius: 250,
    backgroundColor: colors.primary,
  },

      bentoGrid: {
        // Was the old 3-tile bento ROW: width min(348, SCREEN_WIDTH - 40) = 320dp
        // inside a 296dp content box, so it overflowed 12dp per side and the
        // single hero tile rendered 39px LEFT of centre (measured on the device,
        // not guessed). The row layout is gone with the collage, so the leftover
        // width/row rules go with it.
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
      },

  bentoLeft: {
    width: Math.min(BENTO_LEFT_W, (SCREEN_WIDTH - 40 - BENTO_GAP) * (BENTO_LEFT_W / BENTO_W)),
    aspectRatio: 166 / 200,
    borderRadius: 24,
    backgroundColor: colors.surfaceContainerHigh,
    overflow: 'hidden',
  },

  bentoRightCol: {
    flex: 1,
    gap: BENTO_GAP,
  },

  bentoRightTop: {
    flex: 1,
    borderRadius: 24,
    backgroundColor: colors.surfaceContainerHigh,
    overflow: 'hidden',
  },

  bentoRightBottom: {
    flex: 1,
    borderRadius: 24,
    backgroundColor: colors.surfaceContainerHigh,
    overflow: 'hidden',
  },

  // Single coherent hero illustration (replaces the 3-tile collage).
  scroll: {
    flex: 1,
  },

  scrollContent: {
    flexGrow: 1,
  },

      authHero: {
        // SIZE IDENTICAL to the old render, POSITION corrected. Measured on the
        // device: old = 878x768 at x=63..939 (centre 501, 39px LEFT of 540);
        // with aspectRatio:4/5 + maxHeight the box collapsed to 614x768 (the
        // clamp recomputes the width from the clamped height) - Tony: "you
        // cropped the side widths and made it small". No aspectRatio now, so the
        // box is the old 296x280 and only its placement changed: the leftover
        // bento row width min(348, W-40) = 320dp used to overflow the 296dp
        // content box and push it left; bentoGrid is a plain full-width centred
        // box, so width:'100%' lands it where it was designed to be.
        width: '100%',
        maxWidth: 320,
        height: 280,
        borderRadius: 24,
      },
  bentoImage: {
    width: '100%',
    height: '100%',
  },

  footerSection: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24,
    gap: 12,
  },

  primaryButton: {
    width: '100%',
    maxWidth: 350,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.primaryContainer,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },

  buttonTextWhite: {
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 16,
    letterSpacing: 0.14,
    color: colors.onPrimary,
  },

  secondaryButton: {
    width: '100%',
    maxWidth: 350,
    height: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    backgroundColor: colors.surfaceContainerLowest,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },

  buttonTextDark: {
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 16,
    letterSpacing: 0.14,
    color: colors.textPrimary,
  },

  errorText: {
    fontFamily: 'Inter',
    fontSize: 13,
    lineHeight: 18,
    color: colors.error,
    textAlign: 'center',
  },

  devBypassText: {
    fontFamily: 'Inter',
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
    textDecorationLine: 'underline',
  },

  termsText: {
    fontFamily: 'Inter',
    fontSize: 11,
    lineHeight: 24,
    color: colors.textSecondary,
    textAlign: 'center',
    fontWeight: '400',
  },

    termsLink: {
      fontFamily: 'Inter',
      fontSize: 12,
      fontWeight: '600',
      color: colors.primary,
      textDecorationLine: 'underline',
    },
    // Row of real controls: each link is a 44dp-tall touch target.
    termsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
    },
    termsLinkBtn: {
      minHeight: 44,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },

  soonChip: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.surfaceContainer,
  },

  soonText: {
    fontFamily: 'Inter',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.textSecondary,
  },

    loginButton: {
      width: '100%',
      maxWidth: 350,
      // was 40dp - under the 44dp minimum for a standalone control
      height: 44,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // In-flight CTA: dimmed so a cold replace never looks like a dead tap.
    primaryButtonBusy: {
      opacity: 0.7,
    },

  loginButtonText: {
    fontFamily: 'Inter',
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
    fontWeight: '600',
  },

  devModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  devModalCard: {
    backgroundColor: colors.surfaceContainerLowest,
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },

  devModalTitle: {
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },

  devModalSubtitle: {
    fontFamily: 'Inter',
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },

  devInput: {
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.surfaceContainer,
    paddingHorizontal: 14,
    fontFamily: 'Inter',
    fontSize: 14,
    color: colors.textPrimary,
  },

  devModalRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
    marginTop: 4,
  },

  devCancelBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.surfaceContainer,
  },

  devCancelText: {
    fontFamily: 'Inter',
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },

  devConfirmBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.primaryContainer,
  },

  devConfirmText: {
    fontFamily: 'Inter',
    fontSize: 13,
    fontWeight: '600',
    color: colors.onPrimary,
  },
});
