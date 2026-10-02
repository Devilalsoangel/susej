import { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Modal, FlatList } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams } from 'expo-router';
import { ChevronLeftIcon } from '../utils/icons';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../utils/theme';
import { useAuth } from '../contexts/AuthContext';
import { serverApi, transportMessage, authErrorMessage, type AuthIntent } from '../utils/serverApi';
import { goBack, replaceRoute } from '../utils/navigation';
import { OtpBoxes } from '../components/OtpBoxes';

const COUNTRIES = [
  { code: '+91', name: 'India', flag: '🇮🇳' },
];

const OTP_LENGTH = 6;

type AuthMode = 'phone' | 'email';

type LoginResult = {
  ok: boolean;
  error?: string;
  code?: string;
  authCode?: string;
  needsSignup?: boolean;
  accountExists?: boolean;
  attemptsLeft?: number;
  offline?: boolean;
  mode?: AuthIntent;
  created?: boolean;
  setupRequired?: boolean;
};

type LoginWithIntent = (
  phone: string,
  code: string,
  options: { intent: AuthIntent },
) => Promise<LoginResult>;

type AuthContextWithCancel = ReturnType<typeof useAuth> & {
  cancelAuthAttempt?: () => void;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function nationalDigitsFor(countryCode: string, value: string): string {
  const cc = countryCode.replace(/\D/g, '');
  let digits = value.replace(/\D/g, '');
  if (cc && digits.startsWith(cc) && digits.length > (cc === '91' ? 10 : cc.length)) digits = digits.slice(cc.length);
  if (cc === '91' && digits.startsWith('0') && digits.length > 10) digits = digits.slice(1);
  return digits;
}

function canonicalPhoneFor(countryCode: string, value: string): string {
  return `${countryCode.replace(/\D/g, '')}${nationalDigitsFor(countryCode, value)}`;
}

function nationalFromCanonical(countryCode: string, phone: string): string {
  const cc = countryCode.replace(/\D/g, '');
  return phone.startsWith(cc) ? phone.slice(cc.length) : nationalDigitsFor(countryCode, phone);
}

function phoneIsValid(countryCode: string, value: string): boolean {
  const national = nationalDigitsFor(countryCode, value);
  const cc = countryCode.replace(/\D/g, '');
  if (cc === '91') return national.length === 10;
  return national.length >= 6 && national.length <= 12;
}

function phoneWarning(countryCode: string): string {
  return countryCode.replace(/\D/g, '') === '91'
    ? 'Enter a valid 10-digit mobile number'
    : 'Enter a valid mobile number';
}

function resultCode(result: LoginResult): string {
  const code = result.code ?? result.authCode;
  if (typeof code === 'string' && code.trim()) return code.toUpperCase();
  if (result.accountExists) return 'ACCOUNT_EXISTS';
  if (result.needsSignup) return 'SIGNUP_REQUIRED';
  return '';
}

function ChevronDownIcon({ size = 12, color = '#5c5e63' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 8 8" fill="none">
      <Path d="M0 2L4 6L8 2L7.2 1.2L4 4.4L0.8 1.2L0 2Z" fill={color} />
    </Svg>
  );
}

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const auth = useAuth() as AuthContextWithCancel;
  const { serverLogin, serverEmailLogin, isLoggedIn, expiredNotice, clearExpiredNotice, cancelAuthAttempt } = auth;
  const entryParams = useLocalSearchParams<{
    phone?: string | string[];
    cc?: string | string[];
    notice?: string | string[];
  }>();
  const entryPhone = firstParam(entryParams.phone).replace(/\D/g, '');
  const entryCc = firstParam(entryParams.cc);
  const initialCc = COUNTRIES.some((country) => country.code === entryCc) ? entryCc : '+91';
  const entryNotice = firstParam(entryParams.notice);
  const [accountExistsNotice, setAccountExistsNotice] = useState(entryNotice === 'account_exists');
  const [mode, setMode] = useState<AuthMode>('phone');
  const [phone, setPhone] = useState(entryPhone);
  const [countryCode, setCountryCode] = useState(initialCc);
  const [otpSent, setOtpSent] = useState(false);
  const [code, setCode] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [verifying, setVerifying] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [error, setError] = useState('');
  const [devHint, setDevHint] = useState('');
  const [noAccount, setNoAccount] = useState(false);
  // Set only when an unknown number is refused on the sign-in lane. The screen
  // then offers the create flow explicitly instead of quietly becoming a
  // sign-up form behind a "Send code" button.
  const [createInvite, setCreateInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [emailRegister, setEmailRegister] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [otpPhone, setOtpPhone] = useState('');
  const [otpIntent, setOtpIntent] = useState<AuthIntent | null>(null);
  const autoSubmitId = useRef(0);
  const autoSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifyInFlight = useRef(false);
  const sendInFlight = useRef(false);
  const checkInFlight = useRef(false);
  const emailInFlight = useRef(false);
  const phoneRequestId = useRef(0);
  const verifyRequestId = useRef(0);
  const emailRequestId = useRef(0);
  const otpPhoneRef = useRef('');
  const otpIntentRef = useRef<AuthIntent | null>(null);
  const phoneRef = useRef(entryPhone);
  const countryCodeRef = useRef(initialCc);
  const mountedRef = useRef(false);
  const authAttemptId = useRef(0);
  const authAttemptInFlight = useRef(false);
  const authAttemptCommitted = useRef(false);
  const autoStartKeyRef = useRef<string | null>(null);
  const cancelAuthAttemptRef = useRef<(() => void) | undefined>(cancelAuthAttempt);
  const isLoggedInRef = useRef(isLoggedIn);
  const codeComplete = code.every((d) => d !== '');
  const canVerify = codeComplete && Boolean(otpPhone);
  const otpCode = code.join('');
  const loginWithIntent = serverLogin as unknown as LoginWithIntent;
  const autoStartKey = entryNotice === 'account_exists' && phoneIsValid(initialCc, entryPhone)
    ? `${initialCc}:${canonicalPhoneFor(initialCc, entryPhone)}`
    : '';
  phoneRef.current = phone;
  countryCodeRef.current = countryCode;
  cancelAuthAttemptRef.current = cancelAuthAttempt;
  isLoggedInRef.current = isLoggedIn;

  const beginAuthAttempt = () => {
    const id = authAttemptId.current + 1;
    authAttemptId.current = id;
    authAttemptInFlight.current = true;
    authAttemptCommitted.current = false;
    return id;
  };

  const completeAuthAttempt = (id: number, committed: boolean) => {
    if (id !== authAttemptId.current) return;
    if (authAttemptCommitted.current && !committed) return;
    authAttemptInFlight.current = false;
    authAttemptCommitted.current = committed;
  };

  const cancelPendingAuth = () => {
    if (!authAttemptInFlight.current || authAttemptCommitted.current) return;
    if (isLoggedInRef.current) return;
    authAttemptId.current += 1;
    authAttemptInFlight.current = false;
    authAttemptCommitted.current = false;
    phoneRequestId.current += 1;
    verifyRequestId.current += 1;
    emailRequestId.current += 1;
    try {
      cancelAuthAttemptRef.current?.();
    } catch {}
  };

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  useEffect(() => {
    if (!error) return;
    // An OTP failure must persist until the user ACTS on it (Instagram /
    // WhatsApp): auto-dismissing after 6s left the code screen looking
    // untouched, so anyone who glanced up after the timer saw a normal form
    // and concluded the Sign in button was dead. It is proven on-device - the
    // honest "Sign-in is unavailable" message was on screen at +2.2s and gone
    // by +8s, with the button still enabled the whole time. Only the
    // number-step validation hint is genuinely transient, so that one keeps
    // its timer.
    if (otpSent) return;
    const timer = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(timer);
  }, [error, otpSent]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingAuth();
      autoSubmitId.current += 1;
      phoneRequestId.current += 1;
      verifyRequestId.current += 1;
      emailRequestId.current += 1;
      if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
    };
  }, []);

  useEffect(() => {
    cancelPendingAuth();
    phoneRequestId.current += 1;
    verifyRequestId.current += 1;
    emailRequestId.current += 1;
    autoSubmitId.current += 1;
    if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
    sendInFlight.current = false;
    checkInFlight.current = false;
    verifyInFlight.current = false;
    emailInFlight.current = false;
    otpPhoneRef.current = '';
    otpIntentRef.current = null;
    phoneRef.current = entryPhone;
    countryCodeRef.current = initialCc;
    setPhone(entryPhone);
    setCountryCode(initialCc);
    setMode('phone');
    setAccountExistsNotice(entryNotice === 'account_exists');
    setOtpSent(false);
    setCode(Array(OTP_LENGTH).fill(''));
    setVerifying(false);
    setSending(false);
    setResendIn(0);
    setError('');
    setDevHint('');
    setNoAccount(false);
    setOtpPhone('');
    setOtpIntent(null);
    setSigningIn(false);
  }, [entryPhone, initialCc, entryNotice]);

  useEffect(() => {
    // A fresh challenge always starts from an empty code. Focus handling lives
    // in <OtpBoxes> (which owns six real inputs) instead of a hidden overlay.
    if (otpSent) setCode(Array(OTP_LENGTH).fill(''));
  }, [otpSent]);

  const clearAutoSubmit = () => {
    autoSubmitId.current += 1;
    if (autoSubmitTimer.current) {
      clearTimeout(autoSubmitTimer.current);
      autoSubmitTimer.current = null;
    }
  };

  // A failure on the code step stays on screen until the user retypes a digit
  // (or resends / edits the number, which clear it on their own paths).
  // Proven on-device: the honest offline error was visible at +2.2s and gone
  // by +8s while the button stayed enabled the whole time.
  const handleCodeChange = (next: string[]) => {
    if (error) setError('');
    setCode(next);
  };

  const resetPhoneFlow = () => {
    cancelPendingAuth();
    clearAutoSubmit();
    phoneRequestId.current += 1;
    verifyRequestId.current += 1;
    emailRequestId.current += 1;
    emailInFlight.current = false;
    sendInFlight.current = false;
    checkInFlight.current = false;
    verifyInFlight.current = false;
    otpPhoneRef.current = '';
    otpIntentRef.current = null;
    setOtpSent(false);
    setCode(Array(OTP_LENGTH).fill(''));
    setVerifying(false);
    setSending(false);
    setResendIn(0);
    setDevHint('');
    setNoAccount(false);
    setOtpPhone('');
    setOtpIntent(null);
    setSigningIn(false);
    setAccountExistsNotice(false);
    // The create invite belonged to the number that was just refused. Keeping
    // it made the button still read "Create an account" for the NEXT number,
    // which routed an existing account into the signup lane before any
    // existence check ran - the user had to be bounced back out of it.
    setCreateInvite(false);
    setError('');
  };

  const switchMode = (nextMode: AuthMode) => {
    if (nextMode === mode) return;
    resetPhoneFlow();
    setMode(nextMode);
  };

  const handlePhoneChange = (value: string) => {
    const typed = value.replace(/\D/g, '').slice(0, 15);
    // A pasted international number ("+91 98765 43210") must not sit in the
    // field next to a +91 badge: the user then reads a 14-digit number that
    // cannot exist. The send path already normalises it, so the field must show
    // what will actually be sent - the same rule nationalDigitsFor applies.
    const cc = countryCodeRef.current.replace(/\D/g, '');
    const nationalLimit = cc === '91' ? 10 : cc.length;
    const next =
      cc && typed.length > nationalLimit && typed.startsWith(cc) ? typed.slice(cc.length) : typed;
    phoneRef.current = next;
    setPhone(next);
    resetPhoneFlow();
    if (next && !phoneIsValid(countryCodeRef.current, next)) setError(phoneWarning(countryCodeRef.current));
    if (expiredNotice) clearExpiredNotice();
  };

  const requestOtp = async () => {
    if (!mountedRef.current || sending || verifying || sendInFlight.current || verifyInFlight.current) return;
    clearAutoSubmit();
    const activeCountryCode = countryCodeRef.current;
    const activePhone = phoneRef.current;
    if (!phoneIsValid(activeCountryCode, activePhone)) {
      setError(phoneWarning(activeCountryCode));
      return;
    }
    const full = canonicalPhoneFor(activeCountryCode, activePhone);
    const requestId = ++phoneRequestId.current;
    sendInFlight.current = true;
    checkInFlight.current = true;
    setSending(true);
    setError('');
    setAccountExistsNotice(false);
    setNoAccount(false);
    setCreateInvite(false);
    try {
      const check = await serverApi.checkPhone(full);
      if (!mountedRef.current || requestId !== phoneRequestId.current || full !== canonicalPhoneFor(countryCodeRef.current, phoneRef.current)) return;
      if (!check.ok || !check.data || typeof check.data.exists !== 'boolean') {
        setError(authErrorMessage(check.error, 'try again'));
        return;
      }
      if (!check.data.exists) {
        // The sign-in lane NEVER mints an account.
        //
        // It used to pick intent automatically (`exists ? 'login' : 'signup'`)
        // and post a code, so an unknown number verified on THIS screen created
        // a User plus a welcome bonus and a ledger row. That is a money-minting
        // path hidden behind a button labelled "Send code", gated only by
        // CREATE_MAX = 5/hour/PER IP. Sign-in and sign-up are different intents
        // (Instagram, Amazon, WhatsApp): an unknown number gets an offer to
        // create an account, and the create screen mints it - after the user
        // has explicitly chosen to sign up.
        setNoAccount(true);
        setCreateInvite(true);
        return;
      }
      setNoAccount(false);
      setCreateInvite(false);
      const sent = await serverApi.sendOtp(full, 'login');
      if (!mountedRef.current || requestId !== phoneRequestId.current || full !== canonicalPhoneFor(countryCodeRef.current, phoneRef.current)) return;
      if (!sent.ok) {
        setError(authErrorMessage(sent.error, 'try again'));
        return;
      }
      otpPhoneRef.current = full;
      otpIntentRef.current = 'login';
      setOtpPhone(full);
      setOtpIntent('login');
      setCode(Array(OTP_LENGTH).fill(''));
      setResendIn(45);
      setOtpSent(true);
      setDevHint(sent.data?.devCode ? `Dev code: ${sent.data.devCode}` : '');
      setError('');
    } catch {
      if (mountedRef.current && requestId === phoneRequestId.current) setError('No connection. Check your internet and try again.');
    } finally {
      if (requestId === phoneRequestId.current) {
        sendInFlight.current = false;
        checkInFlight.current = false;
        setSending(false);
      }
    }
  };

  useEffect(() => {
    if (!autoStartKey || !mountedRef.current || autoStartKeyRef.current === autoStartKey) return;
    autoStartKeyRef.current = autoStartKey;
    void requestOtp();
  }, [autoStartKey]);

  const replaceWithLogin = (targetPhone: string) =>
    replaceRoute(
      `/login?phone=${encodeURIComponent(
        nationalFromCanonical(countryCode, targetPhone)
      )}&cc=${encodeURIComponent(countryCode)}&notice=account_exists`
    );

  const applyAuthFailure = async (result: LoginResult, targetPhone: string): Promise<boolean> => {
    const code = resultCode(result);
    if (code === 'ACCOUNT_EXISTS' || result.accountExists) {
      if (!(await replaceWithLogin(targetPhone))) {
        setError('Could not open sign in. Please try again.');
        return false;
      }
      return true;
    }
    if (code === 'SIGNUP_REQUIRED' || result.needsSignup) {
      otpPhoneRef.current = '';
      otpIntentRef.current = null;
      setOtpPhone('');
      setOtpIntent(null);
      setOtpSent(false);
      setCode(Array(OTP_LENGTH).fill(''));
      setNoAccount(true);
      setError('This number has no account yet. Send a code to create one and continue to profile setup.');
      return false;
    }
    if (code === 'OTP_EXPIRED' || code === 'CODE_EXPIRED') {
      setCode(Array(OTP_LENGTH).fill(''));
      setError('That code expired. Tap Resend for a fresh one.');
      return false;
    }
    if (code === 'INTENT_MISMATCH') {
      setCode(Array(OTP_LENGTH).fill(''));
      setError('This code belongs to a different sign-in method. Tap Resend for a fresh one.');
      return false;
    }
    const tries = typeof result.attemptsLeft === 'number' && result.attemptsLeft >= 0
      ? ` ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left — check the SMS and retry.`
      : '';
    setError(authErrorMessage(result.error, 'try again') + tries);
    return false;
  };

  const handleVerify = async (codeOverride?: string) => {
    const finalCode = typeof codeOverride === 'string' ? codeOverride : otpCode;
    if (!mountedRef.current || finalCode.length !== OTP_LENGTH || verifying || verifyInFlight.current || sendInFlight.current) return;
    const targetPhone = otpPhoneRef.current || otpPhone;
    const targetIntent = otpIntentRef.current || otpIntent;
    if (!targetPhone || !targetIntent) {
      setError('Request a verification code first.');
      return;
    }
    const requestId = ++verifyRequestId.current;
    const authAttemptRequestId = beginAuthAttempt();
    verifyInFlight.current = true;
    setVerifying(true);
    setError('');
    setSigningIn(false);
    let committed = false;
    try {
      const result = await loginWithIntent(targetPhone, finalCode, { intent: targetIntent });
      if (result.ok) {
        committed = true;
        if (requestId === verifyRequestId.current && targetPhone === (otpPhoneRef.current || otpPhone)) {
          setSigningIn(true);
        }
        return;
      }
      if (requestId !== verifyRequestId.current || targetPhone !== (otpPhoneRef.current || otpPhone)) return;
      if (result.offline) {
        setError('Sign-in is unavailable. Check your connection and try again.');
        return;
      }
      await applyAuthFailure(result, targetPhone);
    } catch {
      if (requestId === verifyRequestId.current) {
        setSigningIn(false);
        setError('Sign-in is unavailable. Check your connection and try again.');
      }
    } finally {
      completeAuthAttempt(authAttemptRequestId, committed);
      if (requestId === verifyRequestId.current) {
        verifyInFlight.current = false;
        setVerifying(false);
      }
    }
  };

  const handleResend = () => {
    if (resendIn > 0 || verifying || sending || verifyInFlight.current || sendInFlight.current) return;
    void requestOtp();
  };

  const handleEmailAuth = async () => {
    if (!mountedRef.current || emailInFlight.current || verifying) return;
    const requestId = ++emailRequestId.current;
    const authAttemptRequestId = beginAuthAttempt();
    emailInFlight.current = true;
    setVerifying(true);
    setError('');
    let committed = false;
    try {
      const result = await serverEmailLogin(emailRegister ? 'register' : 'login', email, password, name);
      if (result.ok) {
        committed = true;
        return;
      }
      if (requestId !== emailRequestId.current) return;
      setError(result.error ? authErrorMessage(result.error, 'try again') : transportMessage(undefined, 'try again'));
    } catch {
      if (requestId === emailRequestId.current) setError('Sign-in is unavailable. Check your connection and try again.');
    } finally {
      completeAuthAttempt(authAttemptRequestId, committed);
      if (requestId === emailRequestId.current) {
        emailInFlight.current = false;
        setVerifying(false);
      }
    }
  };

  const selectCountry = (code: string) => {
    countryCodeRef.current = code;
    setCountryCode(code);
    setShowCountryPicker(false);
    resetPhoneFlow();
  };

  const goCreateAccount = () => {
    if (sending || verifying) return;
    const activeCountryCode = countryCodeRef.current;
    const activePhone = phoneRef.current;
    if (!phoneIsValid(activeCountryCode, activePhone)) return;
    const national = nationalFromCanonical(
      activeCountryCode,
      canonicalPhoneFor(activeCountryCode, activePhone)
    );
    void replaceRoute(
      `/(onboarding)/otp?phone=${encodeURIComponent(national)}&cc=${encodeURIComponent(activeCountryCode)}`
    );
  };

  const handlePhonePrimaryAction = () => {
    // Once an unknown number has been refused, this button IS the create
    // action. Re-running requestOtp() here would only re-check and re-refuse -
    // a button that says "Create an account" and does nothing.
    if (createInvite) {
      goCreateAccount();
      return;
    }
    void requestOtp();
  };

  const handleBack = () => {
    if (verifying) return;
    resetPhoneFlow();
    goBack('/(onboarding)/welcome');
  };

  // The session committed: this screen belongs to the side the user just left.
  // Rendering it (and the "Signing you in…" overlay on top of it) after the
  // tree swapped is the stale-auth-surface half of the auth tree loop - the OTP
  // screen already returns null here, the sign-in screen did not.
  if (isLoggedIn) return null;

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      <StatusBar style="dark" />
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-row items-center px-5" style={{ height: 52 }}>
          <TouchableOpacity disabled={verifying} onPress={handleBack}>
            <ChevronLeftIcon size={18} color={colors.primary} />
          </TouchableOpacity>
          <Text className="flex-1 text-center font-inter-700" style={{ fontSize: 20, lineHeight: 28, letterSpacing: -0.5, color: colors.primary }}>
            susej
          </Text>
          <View style={{ width: 18 }} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}>
          <View className="px-8 pt-4">
            <Text className="font-inter-700" style={{ fontSize: 28, lineHeight: 36, letterSpacing: -0.56, color: colors.textPrimary }}>
              Welcome back
            </Text>
            <Text className="font-inter-400 mt-1 mb-5" style={{ fontSize: 14, lineHeight: 20, color: colors.textSecondary }}>
              Sign in to continue to the marketplace.
            </Text>
            {expiredNotice ? (
              <Text className="font-inter-500 mb-4" style={{ fontSize: 13, lineHeight: 18, color: colors.tertiary }}>
                Your session expired. Please log in again.
              </Text>
            ) : null}
            {accountExistsNotice ? (
              <Text className="font-inter-500 mb-4" style={{ fontSize: 13, lineHeight: 18, color: colors.textSecondary }}>
                This number already has an account. Sign in below instead.
              </Text>
            ) : null}

            <View className="flex-row mb-6 rounded-figma-16 p-1" style={{ backgroundColor: colors.surfaceContainer }}>
              {(['phone', 'email'] as AuthMode[]).map((item) => (
                <TouchableOpacity
                  key={item}
                  className="flex-1 h-10 items-center justify-center rounded-figma-12"
                  style={{ backgroundColor: mode === item ? colors.surfaceContainerLowest : 'transparent' }}
                  onPress={() => switchMode(item)}
                >
                  <Text className="font-inter-600 capitalize" style={{ fontSize: 13, lineHeight: 18, color: mode === item ? colors.textPrimary : colors.textSecondary }}>
                    {item === 'phone' ? 'Phone' : 'Email'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {mode === 'phone' ? (
              !otpSent ? (
                <>
                  <View className="flex-row items-center mb-5" style={{ gap: 8 }}>
                    <TouchableOpacity className="h-14 px-4 rounded-figma-16 flex-row items-center" style={{ backgroundColor: colors.surfaceContainer }} onPress={() => setShowCountryPicker(true)}>
                      <Text className="font-inter-400" style={{ fontSize: 16, lineHeight: 24, color: colors.textPrimary }}>
                        {countryCode}
                      </Text>
                      <View style={{ marginLeft: 4 }}>
                        <ChevronDownIcon size={12} color={colors.textSecondary} />
                      </View>
                    </TouchableOpacity>
                    <View className="flex-1 h-14 px-4 rounded-figma-16 justify-center" style={{ backgroundColor: colors.surfaceContainer }}>
                      <TextInput
                        className="font-inter-400"
                        style={{ fontSize: 16, color: colors.textPrimary }}
                        placeholder="98765 43210"
                        placeholderTextColor="rgba(70,69,85,0.4)"
                        keyboardType="phone-pad"
                        value={phone}
                        onChangeText={handlePhoneChange}
                      />
                    </View>
                  </View>
                  {error ? (
                    <Text className="font-inter-500 mb-3" style={{ fontSize: 13, lineHeight: 18, color: colors.error }}>
                      {error}
                    </Text>
                  ) : null}
                  {noAccount && !otpSent ? (
                    <View className="mb-4 rounded-figma-16 p-4" style={{ backgroundColor: colors.surfaceContainer }}>
                      <Text
                        className="font-inter-500"
                        style={{ fontSize: 13, lineHeight: 19, color: colors.textSecondary }}
                      >
                        This number has no account yet, so no code was sent. Use the
                        button below if you want to create one.
                      </Text>
                    </View>
                  ) : null}
                  {/* ONE create-account affordance, not three. The primary
                      button becomes the create action once an unknown number is
                      refused, and the "New here?" link hides itself so the screen
                      can never present the same choice twice - which also killed a
                      dead tap, because the primary button used to re-run the
                      request that had just been refused. */}
                  <TouchableOpacity
                    className="w-full h-14 items-center justify-center rounded-figma-16 mb-6"
                    style={{ backgroundColor: phoneIsValid(countryCode, phone) && !sending ? colors.primary : 'rgba(93,95,239,0.2)' }}
                    onPress={handlePhonePrimaryAction}
                    disabled={sending || verifying || sendInFlight.current || verifyInFlight.current || !phoneIsValid(countryCode, phone)}
                  >
                    <Text className="font-inter-600" style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: phoneIsValid(countryCode, phone) && !sending ? '#FFFFFF' : 'rgba(70,69,85,0.4)' }}>
                      {sending ? 'Checking…' : createInvite || noAccount ? 'Create an account' : 'Send code'}
                    </Text>
                  </TouchableOpacity>
                  {createInvite ? null : (
                   <TouchableOpacity
                     className="items-center mb-2"
                     disabled={!phoneIsValid(countryCode, phone)}
                     onPress={goCreateAccount}
                   >
                     <Text className="font-inter-500 text-center" style={{ fontSize: 12, lineHeight: 16, color: phoneIsValid(countryCode, phone) ? colors.primary : colors.textSecondary }}>
                       New here? Create an account
                     </Text>
                   </TouchableOpacity>
                  )}
                </>
              ) : (
                <>
                  <Text className="font-inter-400 mb-4" style={{ fontSize: 13, lineHeight: 19, color: colors.textSecondary }}>
                    We sent a 6-digit code to +{countryCode.replace(/\D/g, '')} {nationalFromCanonical(countryCode, otpPhone || canonicalPhoneFor(countryCode, phone))}.
                  </Text>
                  {devHint && !error ? (
                    <Text className="font-inter-500 mb-3" style={{ fontSize: 13, lineHeight: 18, color: colors.tertiary }}>
                      {devHint}
                    </Text>
                  ) : null}
                   {error ? (
                     <Text className="font-inter-500 mb-3" style={{ fontSize: 13, lineHeight: 18, color: colors.error }}>
                       {error}
                     </Text>
                   ) : null}
                   {noAccount ? (
                     <Text className="font-inter-500 mb-3" style={{ fontSize: 13, lineHeight: 18, color: colors.textSecondary }}>
                       Verifying this code creates your account and takes you to profile setup.
                     </Text>
                   ) : null}
                    <View className="mb-6">
                      <OtpBoxes
                        code={code}
                        onChange={handleCodeChange}
                        onComplete={(full) => void handleVerify(full)}
                        autoFocus={otpSent}
                        disabled={verifying || sending}
                      />
                    </View>
                  <TouchableOpacity
                    className="w-full h-14 items-center justify-center rounded-figma-16 mb-6"
                    style={{ backgroundColor: canVerify && !verifying ? colors.primary : 'rgba(93,95,239,0.2)' }}
                    disabled={!canVerify || verifying || sending}
                    onPress={() => void handleVerify()}
                  >
                    <Text className="font-inter-600" style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: canVerify && !verifying ? '#FFFFFF' : 'rgba(70,69,85,0.4)' }}>
                      {verifying ? (otpIntent === 'signup' ? 'Creating account…' : 'Signing in…') : otpIntent === 'signup' ? 'Create account' : 'Sign in'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity disabled={resendIn > 0 || verifying || sending || verifyInFlight.current || sendInFlight.current} onPress={handleResend} className="items-center">
                    <Text className="font-inter-600" style={{ fontSize: 13, lineHeight: 18, color: resendIn > 0 ? colors.textSecondary : colors.primary }}>
                      {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                    </Text>
                  </TouchableOpacity>
                </>
              )
            ) : (
              <>
                {emailRegister ? (
                  <TextInput
                    className="h-14 px-4 rounded-figma-16 font-inter-400 mb-3"
                    style={{ backgroundColor: colors.surfaceContainer, fontSize: 15, color: colors.textPrimary }}
                    placeholder="Full name"
                    placeholderTextColor="rgba(70,69,85,0.4)"
                    value={name}
                    onChangeText={(value) => { setName(value); if (error) setError(''); }}
                    autoCapitalize="words"
                  />
                ) : null}
                <TextInput
                  className="h-14 px-4 rounded-figma-16 font-inter-400 mb-3"
                  style={{ backgroundColor: colors.surfaceContainer, fontSize: 15, color: colors.textPrimary }}
                  placeholder="Email address"
                  placeholderTextColor="rgba(70,69,85,0.4)"
                  value={email}
                  onChangeText={(value) => { setEmail(value); if (error) setError(''); }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
                <TextInput
                  className="h-14 px-4 rounded-figma-16 font-inter-400 mb-2"
                  style={{ backgroundColor: colors.surfaceContainer, fontSize: 15, color: colors.textPrimary }}
                  placeholder={emailRegister ? 'Create a password (min 8 characters)' : 'Password'}
                  placeholderTextColor="rgba(70,69,85,0.4)"
                  value={password}
                  onChangeText={(value) => { setPassword(value); if (error) setError(''); }}
                  secureTextEntry
                />
                {error ? (
                  <Text className="font-inter-500 mb-3 mt-2" style={{ fontSize: 13, lineHeight: 18, color: colors.error }}>
                    {error}
                  </Text>
                ) : null}
                <TouchableOpacity
                  className="w-full h-14 items-center justify-center rounded-figma-16 mb-3"
                  style={{
                    backgroundColor: email.includes('@') && password.length >= 8 && (!emailRegister || name.trim().length >= 2) && !verifying && !emailInFlight.current
                      ? colors.primary
                      : 'rgba(93,95,239,0.2)',
                  }}
                  disabled={!email.includes('@') || password.length < 8 || (emailRegister && name.trim().length < 2) || verifying || emailInFlight.current}
                  onPress={() => void handleEmailAuth()}
                >
                  <Text className="font-inter-600" style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: email.includes('@') && password.length >= 8 && (!emailRegister || name.trim().length >= 2) && !verifying && !emailInFlight.current ? '#FFFFFF' : 'rgba(70,69,85,0.4)' }}>
                    {verifying ? 'Please wait…' : emailRegister ? 'Create account' : 'Sign in'}
                  </Text>
                </TouchableOpacity>
                  <Text className="font-inter-400 text-center" style={{ fontSize: 12, lineHeight: 16, color: colors.textSecondary }}>
                    {emailRegister ? 'Already have an account? ' : 'New here? '}
                    <Text className="font-inter-600" style={{ color: colors.primary }} onPress={() => {
                      if (verifying || emailInFlight.current) return;
                      cancelPendingAuth();
                      setEmailRegister(!emailRegister);
                      setError('');
                    }}>
                      {emailRegister ? 'Sign in' : 'Create an account'}
                    </Text>
                  </Text>

              </>
            )}
          </View>
        </ScrollView>
        {signingIn ? (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
            <Text className="font-inter-600" style={{ fontSize: 16, color: colors.textPrimary }}>
              {otpIntent === 'signup' ? 'Setting up your account…' : 'Signing you in…'}
            </Text>
          </View>
        ) : null}
      </SafeAreaView>
      <Modal visible={showCountryPicker} transparent animationType="fade" onRequestClose={() => setShowCountryPicker(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }} activeOpacity={1} onPress={() => setShowCountryPicker(false)}>
          <View style={{ backgroundColor: colors.surfaceContainerLowest, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: 380, paddingTop: 12 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.outlineVariant, alignSelf: 'center', marginBottom: 12 }} />
            <Text className="font-inter-600" style={{ fontSize: 16, textAlign: 'center', marginBottom: 12, color: colors.textPrimary }}>Select country</Text>
            <FlatList data={COUNTRIES} keyExtractor={(item) => item.code} renderItem={({ item }) => (
              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 14, backgroundColor: countryCode === item.code ? colors.surfaceContainer : 'transparent' }} onPress={() => selectCountry(item.code)}>
                <Text style={{ fontSize: 20, marginRight: 12 }}>{item.flag}</Text>
                <Text className="font-inter-400" style={{ flex: 1, fontSize: 15, color: colors.textPrimary }}>{item.name}</Text>
                <Text className="font-inter-600" style={{ fontSize: 15, color: colors.textPrimary }}>{item.code}</Text>
              </TouchableOpacity>
            )} />
            <View style={{ height: 24 }} />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}
