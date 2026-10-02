import { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, Modal, FlatList, ScrollView, BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { ChevronLeftIcon, PhoneIcon, ShieldCheckIcon } from '../../utils/icons';
import { colors } from '../../utils/theme';
import { useAuth } from '../../contexts/AuthContext';
import { serverApi, authErrorMessage, type AuthIntent } from '../../utils/serverApi';
import { replaceRoute } from '../../utils/navigation';
import { OtpBoxes } from '../../components/OtpBoxes';

const COUNTRIES = [
  { code: '+91', name: 'India', flag: '🇮🇳' },
];

const OTP_LENGTH = 6;

type AuthResult = {
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
) => Promise<AuthResult>;

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

function resultCode(result: AuthResult): string {
  const code = result.code ?? result.authCode;
  if (typeof code === 'string' && code.trim()) return code.toUpperCase();
  if (result.accountExists) return 'ACCOUNT_EXISTS';
  if (result.needsSignup) return 'SIGNUP_REQUIRED';
  return '';
}

export default function OtpScreen() {
  const insets = useSafeAreaInsets();
  const auth = useAuth() as AuthContextWithCancel;
  const { serverLogin, isLoading, isLoggedIn, cancelAuthAttempt } = auth;
  const entryParams = useLocalSearchParams<{ phone?: string | string[]; cc?: string | string[] }>();
  const prefillPhone = firstParam(entryParams.phone).replace(/\D/g, '');
  const entryCc = firstParam(entryParams.cc);
  const prefillCc = COUNTRIES.some((country) => country.code === entryCc) ? entryCc : '+91';
  const [phone, setPhone] = useState(prefillPhone);
  const [countryCode, setCountryCode] = useState(prefillCc);
  const [checking, setChecking] = useState(false);
  const [createConfirmed, setCreateConfirmed] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [code, setCode] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [verifying, setVerifying] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [error, setError] = useState('');
  const [devHint, setDevHint] = useState('');
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [otpPhone, setOtpPhone] = useState('');
  const [checkingBeforeVerify, setCheckingBeforeVerify] = useState(false);
  const codeComplete = code.every((digit) => digit !== '');
  const canVerify = codeComplete && Boolean(otpPhone);
  const otpCode = code.join('');
  const autoSubmitId = useRef(0);
  const autoSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifyInFlight = useRef(false);
  const sendInFlight = useRef(false);
  const checkInFlight = useRef(false);
  const checkRequestId = useRef(0);
  const sendRequestId = useRef(0);
  const verifyRequestId = useRef(0);
  const otpPhoneRef = useRef('');
  const otpIntentRef = useRef<AuthIntent | null>(null);
  const phoneRef = useRef(prefillPhone);
  const countryCodeRef = useRef(prefillCc);
  const mountedRef = useRef(false);
  const authAttemptId = useRef(0);
  const authAttemptInFlight = useRef(false);
  const authAttemptCommitted = useRef(false);
  const cancelAuthAttemptRef = useRef<(() => void) | undefined>(cancelAuthAttempt);
  const isLoggedInRef = useRef(isLoggedIn);
  const loginWithIntent = serverLogin as unknown as LoginWithIntent;
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
    checkRequestId.current += 1;
    sendRequestId.current += 1;
    verifyRequestId.current += 1;
    try {
      cancelAuthAttemptRef.current?.();
    } catch {}
  };

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  // REMOVED: the 6-second auto-dismiss on the verify error. /login already had
  // this removed for exactly the same reason - a wrong OTP is the single most
  // important thing to tell the user, and auto-clearing it makes a live screen
  // look like nothing happened (proved: server returned 401 "Incorrect code",
  // the message was gone before the user could read it). The error now clears
  // when the user edits the code or taps Resend.

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingAuth();
      autoSubmitId.current += 1;
      checkRequestId.current += 1;
      sendRequestId.current += 1;
      verifyRequestId.current += 1;
      if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
    };
  }, []);

  useEffect(() => {
    cancelPendingAuth();
    autoSubmitId.current += 1;
    checkRequestId.current += 1;
    sendRequestId.current += 1;
    verifyRequestId.current += 1;
    if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
    checkInFlight.current = false;
    sendInFlight.current = false;
    verifyInFlight.current = false;
    otpPhoneRef.current = '';
    otpIntentRef.current = null;
    phoneRef.current = prefillPhone;
    countryCodeRef.current = prefillCc;
    setPhone(prefillPhone);
    setCountryCode(prefillCc);
    setChecking(false);
    setCreateConfirmed(false);
    setOtpSent(false);
    setCode(Array(OTP_LENGTH).fill(''));
    setVerifying(false);
    setSending(false);
    setResendIn(0);
    setError('');
    setDevHint('');
    setOtpPhone('');
    setCheckingBeforeVerify(false);
  }, [prefillPhone, prefillCc]);

  useEffect(() => {
    // A fresh challenge always starts empty. Focus lives in <OtpBoxes>, which
    // owns six real per-digit inputs instead of one hidden overlay.
    if (otpSent) setCode(Array(OTP_LENGTH).fill(''));
  }, [otpSent]);

  const clearAutoSubmit = () => {
    autoSubmitId.current += 1;
    if (autoSubmitTimer.current) {
      clearTimeout(autoSubmitTimer.current);
      autoSubmitTimer.current = null;
    }
  };

  const resetNumberFlow = () => {
    cancelPendingAuth();
    clearAutoSubmit();
    checkRequestId.current += 1;
    sendRequestId.current += 1;
    verifyRequestId.current += 1;
    checkInFlight.current = false;
    sendInFlight.current = false;
    verifyInFlight.current = false;
    otpPhoneRef.current = '';
    otpIntentRef.current = null;
    setChecking(false);
    setCreateConfirmed(false);
    setOtpSent(false);
    setCode(Array(OTP_LENGTH).fill(''));
    setVerifying(false);
    setSending(false);
    setResendIn(0);
    setDevHint('');
    setError('');
    setOtpPhone('');
    setCheckingBeforeVerify(false);
  };

  // The number split must come from the LIVE country code, not the render
  // snapshot: this is dispatched from async paths (pre-check, verify failure)
  // where the user may already have switched country, and a stale '+91' would
  // hand the sign-in screen a mangled number.
  const routeExistingToSignIn = (targetPhone: string) => {
    const activeCc = countryCodeRef.current;
    return replaceRoute(
      `/login?phone=${encodeURIComponent(
        nationalFromCanonical(activeCc, targetPhone)
      )}&cc=${encodeURIComponent(activeCc)}&notice=account_exists`
    );
  };

  const checkAndSend = async () => {
    if (!mountedRef.current || checkInFlight.current || sendInFlight.current || verifyInFlight.current || checking || sending || verifying) return null;
    clearAutoSubmit();
    const activeCountryCode = countryCodeRef.current;
    const activePhone = phoneRef.current;
    if (!phoneIsValid(activeCountryCode, activePhone)) {
      setError(phoneWarning(activeCountryCode));
      return null;
    }
    const full = canonicalPhoneFor(activeCountryCode, activePhone);
    const checkId = ++checkRequestId.current;
    const sendId = ++sendRequestId.current;
    checkInFlight.current = true;
    sendInFlight.current = true;
    setChecking(true);
    setSending(true);
    setError('');
    setCreateConfirmed(false);
    try {
      const check = await serverApi.checkPhone(full);
      if (!mountedRef.current || checkId !== checkRequestId.current || sendId !== sendRequestId.current || full !== canonicalPhoneFor(countryCodeRef.current, phoneRef.current)) return null;
      if (!check.ok || !check.data || typeof check.data.exists !== 'boolean') {
        setError(authErrorMessage(check.error, 'try again'));
        return null;
      }
      if (check.data.exists) {
        // Awaited: a bare `!routeExistingToSignIn(...)` tests a Promise object
        // (always truthy), so a failed redirect used to look like a success.
        if (!(await routeExistingToSignIn(full))) {
          setError('Could not open sign in. Please try again.');
        }
        return null;
      }
      setCreateConfirmed(true);
      const sent = await serverApi.sendOtp(full, 'signup');
      if (!mountedRef.current || checkId !== checkRequestId.current || sendId !== sendRequestId.current || full !== canonicalPhoneFor(countryCodeRef.current, phoneRef.current)) return null;
      if (!sent.ok) {
        setError(authErrorMessage(sent.error, 'try again'));
        return null;
      }
      otpPhoneRef.current = full;
      otpIntentRef.current = 'signup';
      setOtpPhone(full);
      setCode(Array(OTP_LENGTH).fill(''));
      setResendIn(45);
      setOtpSent(true);
      setDevHint(sent.data?.devCode ? `Dev code: ${sent.data.devCode}` : '');
      setError('');
      return sent;
    } catch {
      if (mountedRef.current && checkId === checkRequestId.current && sendId === sendRequestId.current) {
        setError('Could not check or send a code. Check your connection and try again.');
      }
      return null;
    } finally {
      if (checkId === checkRequestId.current && sendId === sendRequestId.current) {
        checkInFlight.current = false;
        sendInFlight.current = false;
        setChecking(false);
        setSending(false);
      }
    }
  };

  const handlePhoneChange = (value: string) => {
    const next = value.replace(/\D/g, '').slice(0, 15);
    phoneRef.current = next;
    setPhone(next);
    resetNumberFlow();
    if (next && !phoneIsValid(countryCodeRef.current, next)) setError(phoneWarning(countryCodeRef.current));
  };

  const selectCountry = (code: string) => {
    countryCodeRef.current = code;
    setCountryCode(code);
    setShowCountryPicker(false);
    resetNumberFlow();
  };

  const applyAuthFailure = async (result: AuthResult, targetPhone: string): Promise<boolean> => {
    const code = resultCode(result);
    if (code === 'ACCOUNT_EXISTS' || result.accountExists) {
      if (!(await routeExistingToSignIn(targetPhone))) {
        setError('Could not open sign in. Please try again.');
        return false;
      }
      return true;
    }
    if (code === 'SIGNUP_REQUIRED' || result.needsSignup) {
      setCode(Array(OTP_LENGTH).fill(''));
      setError('This number is new. Request a fresh code to create the account.');
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
    // gpt vision on the error state: "missing punctuation makes it slightly
    // rushed" and "'4 tries left' feels like the app is scolding the user ...
    // '4 attempts remaining' feels factual, not punitive", plus "a cleaner
    // rhythm" as two sentences rather than one run-on.
    const tries = typeof result.attemptsLeft === 'number' && result.attemptsLeft >= 0
      ? `. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'attempt' : 'attempts'} remaining. Check your SMS and try again.`
      : '. Check your SMS and try again.';
    setError(authErrorMessage(result.error, 'try again') + tries);
    return false;
  };

  const handleVerify = async (codeOverride?: string) => {
    const finalCode = typeof codeOverride === 'string' ? codeOverride : otpCode;
    if (!mountedRef.current || finalCode.length !== OTP_LENGTH || verifying || verifyInFlight.current || sendInFlight.current || !otpSent) return;
    const targetPhone = otpPhoneRef.current || otpPhone;
    const targetIntent = otpIntentRef.current;
    if (!targetPhone || targetIntent !== 'signup') {
      setError('Request a verification code first.');
      return;
    }
    const requestId = ++verifyRequestId.current;
    const phoneId = checkRequestId.current;
    let authAttemptRequestId: number | null = null;
    verifyInFlight.current = true;
    setVerifying(true);
    setError('');
    setCheckingBeforeVerify(true);
    let committed = false;
    try {
      const check = await serverApi.checkPhone(targetPhone);
      if (requestId !== verifyRequestId.current || phoneId !== checkRequestId.current || targetPhone !== (otpPhoneRef.current || otpPhone)) return;
      setCheckingBeforeVerify(false);
      if (!check.ok || !check.data || typeof check.data.exists !== 'boolean') {
        setError(authErrorMessage(check.error, 'try again'));
        return;
      }
      if (check.data.exists) {
        // Awaited: `routeExistingToSignIn` returns a Promise, and `!promise` is
        // always false - so this branch could never report a failed redirect
        // and the user was left staring at a sign-up screen for an account that
        // already exists. The sibling pre-check below already awaits correctly.
        if (!(await routeExistingToSignIn(targetPhone))) {
          setError('Could not open sign in. Please try again.');
        }
        return;
      }
      authAttemptRequestId = beginAuthAttempt();
      const result = await loginWithIntent(targetPhone, finalCode, { intent: targetIntent });
      if (result.ok) {
        committed = true;
        return;
      }
      if (requestId !== verifyRequestId.current || targetPhone !== (otpPhoneRef.current || otpPhone)) return;
      if (result.offline) {
        setError('Sign-in is unavailable. Check your connection and try again.');
        return;
      }
      applyAuthFailure(result, targetPhone);
    } catch {
      if (requestId === verifyRequestId.current) {
        setCheckingBeforeVerify(false);
        setError('Sign-in is unavailable. Check your connection and try again.');
      }
    } finally {
      if (authAttemptRequestId !== null) completeAuthAttempt(authAttemptRequestId, committed);
      if (requestId === verifyRequestId.current) {
        verifyInFlight.current = false;
        setVerifying(false);
        setCheckingBeforeVerify(false);
      }
    }
  };

  const handleResend = () => {
    if (resendIn > 0 || verifying || checking || sendInFlight.current || verifyInFlight.current) return;
    void checkAndSend();
  };

  const handleBack = () => {
    if (verifying) return;
    const targetPhone = otpPhoneRef.current || canonicalPhoneFor(countryCodeRef.current, phoneRef.current);
    resetNumberFlow();
    const params = phoneIsValid(countryCode, targetPhone)
      ? `?phone=${encodeURIComponent(
          nationalFromCanonical(countryCode, targetPhone)
        )}&cc=${encodeURIComponent(countryCode)}`
      : '';
    if (!replaceRoute(`/(onboarding)/auth${params}`)) {
      setError('Could not go back. Please try again.');
    }
  };

  if (isLoading || isLoggedIn) return null;

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      <View className="flex-row items-center px-5" style={{ height: 72 + insets.top, paddingTop: insets.top }}>
        <TouchableOpacity
          disabled={verifying}
          onPress={handleBack}
          hitSlop={{ top: 13, bottom: 13, left: 13, right: 13 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityState={{ disabled: verifying }}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -13 }}
        >
          <ChevronLeftIcon size={18} color={colors.primary} />
        </TouchableOpacity>
        <Text className="flex-1 text-center font-inter-700" accessibilityRole="header" style={{ fontSize: 20, lineHeight: 28, letterSpacing: -0.5, marginRight: 18, color: colors.primary }}>
          susej
        </Text>
      </View>

      <ScrollView className="flex-1 px-8" showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
        {/* Decorative: a screen reader must hear the task, not "icon". Sized
            down (was 80dp, then 64dp) to hand the vertical space back to the
            form - gpt vision: "the icon could be 10-20% smaller and brought
            slightly closer to the headline". */}
        <View className="items-center mb-3" accessible={false} importantForAccessibility="no">
          <View className="w-14 h-14 rounded-full items-center justify-center" style={{ backgroundColor: 'rgba(93,95,239,0.1)' }}>
            <PhoneIcon size={20} color={colors.primary} />
          </View>
        </View>

        <Text className="font-inter-700 mb-2" accessibilityRole="header" style={{ fontSize: 28, lineHeight: 36, letterSpacing: -0.5, color: colors.textPrimary }}>
          {otpSent ? 'Enter the 6-digit code' : 'Create your account'}
        </Text>
        <Text className="font-inter-400 mb-6" style={{ fontSize: 15, lineHeight: 23, color: colors.textSecondary }}>
          {otpSent ? (
            // gpt vision: "the body text wraps awkwardly: 'We've sent a
            // verification code to +91' / '9000009006.' - a more premium layout
            // might keep the number visually grouped". Put the destination on
            // its own line and give it weight so it reads as a unit.
            <>
              We’ve sent a 6-digit code to{'\n'}
              <Text className="font-inter-600" style={{ color: colors.textPrimary }}>
                +{countryCode.replace(/\D/g, '')} {nationalFromCanonical(countryCode, otpPhone || canonicalPhoneFor(countryCode, phone))}
              </Text>
            </>
          ) : (
            'Enter your phone number. We’ll send a 6-digit verification code to secure your new account.'
          )}
        </Text>

        {!otpSent ? (
          <>
            <View className="flex-row items-center mb-4" style={{ gap: 8 }}>
              <TouchableOpacity
                className="h-14 px-4 rounded-figma-16 flex-row items-center"
                style={{ backgroundColor: colors.surfaceContainer }}
                onPress={() => setShowCountryPicker(true)}
                accessibilityRole="button"
                accessibilityLabel={`Change country code, currently ${countryCode}`}
              >
                <Text className="font-inter-400" style={{ fontSize: 16, lineHeight: 24, color: colors.textPrimary }}>
                  {countryCode}
                </Text>
                <Text style={{ fontSize: 10, marginLeft: 4, color: colors.textSecondary }}>▼</Text>
              </TouchableOpacity>
              <View className="flex-1 h-14 px-4 rounded-figma-16 justify-center" style={{ backgroundColor: colors.surfaceContainer }}>
                <TextInput
                  className="font-inter-400"
                  style={{ fontSize: 16, color: colors.textPrimary }}
                  placeholder="98765 43210"
                  // 0.4 alpha read as "barely visible" (gpt vision) - a hint, not a ghost.
                  placeholderTextColor="rgba(70,69,85,0.78)"
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={handlePhoneChange}
                  accessibilityLabel="Phone number"
                  accessibilityHint="Enter your 10 digit mobile number"
                />
              </View>
            </View>

            {error ? (
              <Text className="font-inter-500 mb-3" accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ fontSize: 13, lineHeight: 18, color: colors.error }}>
                {error}
              </Text>
            ) : null}
            {createConfirmed ? (
              <Text className="font-inter-500 mb-4" accessibilityLiveRegion="polite" style={{ fontSize: 13, lineHeight: 19, color: colors.textSecondary }}>
                This number has no account. Creating one will open profile setup after verification.
              </Text>
            ) : null}
            <TouchableOpacity
              className="w-full h-14 flex-row items-center justify-center rounded-figma-16 mb-6"
              style={{ backgroundColor: phoneIsValid(countryCode, phone) && !sending && !checking ? colors.primary : 'rgba(93,95,239,0.2)' }}
              onPress={() => void checkAndSend()}
              disabled={sending || checking || sendInFlight.current || verifyInFlight.current || !phoneIsValid(countryCode, phone)}
              accessibilityRole="button"
              accessibilityLabel="Create account and send verification code"
              accessibilityState={{ disabled: sending || checking || !phoneIsValid(countryCode, phone), busy: checking || sending }}
            >
              {/* Disabled must read as INACTIVE, not invisible: the label was
                  0.4 alpha over a 0.2-alpha fill. */}
              <Text className="font-inter-600" style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: phoneIsValid(countryCode, phone) && !sending && !checking ? '#FFFFFF' : 'rgba(26,26,46,0.78)' }}>
                {checking ? 'Checking and sending…' : sending ? 'Sending…' : 'Create account'}
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {error ? (
              <Text className="font-inter-500 mb-3" accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ fontSize: 13, lineHeight: 18, color: colors.error }}>
                {error}
              </Text>
            ) : null}
            <View className="mb-7">
          <OtpBoxes
              code={code}
              invalid={Boolean(error)}
              onChange={(next) => {
                setCode(next);
                // Typing is the user correcting the mistake, so the error goes
                // away the moment they touch the boxes - not 6 seconds after the
                // server replied, which is what the old timer did (verified:
                // the server answered 401 "Incorrect code" and by the time the
                // user looked up there was no message left on screen).
                if (error) setError('');
              }}
                onComplete={(full) => void handleVerify(full)}
                autoFocus={otpSent}
                disabled={verifying || sending}
              />
            </View>

            <TouchableOpacity
              className="w-full h-14 flex-row items-center justify-center rounded-figma-16 mb-5"
              style={{ backgroundColor: canVerify && !verifying && !checkingBeforeVerify ? colors.primary : 'rgba(93,95,239,0.42)' }}
              disabled={!canVerify || verifying || checkingBeforeVerify}
              onPress={() => void handleVerify()}
              accessibilityRole="button"
              accessibilityLabel="Verify and create account"
              accessibilityState={{ disabled: !canVerify || verifying || checkingBeforeVerify, busy: verifying || checkingBeforeVerify }}
            >
              <Text className="font-inter-600" style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: canVerify && !verifying && !checkingBeforeVerify ? '#FFFFFF' : 'rgba(26,26,46,0.78)' }}>
                {checkingBeforeVerify ? 'Checking…' : verifying ? 'Verifying…' : 'Verify and create account'}
              </Text>
            </TouchableOpacity>

            <View className="flex-row items-center justify-center">
              <Text className="font-inter-400" style={{ fontSize: 14, lineHeight: 20, color: colors.textSecondary }}>
                Didn't get the code?{' '}
              </Text>
              {/* 44dp target: this was a bare text link with no height at all. */}
              <TouchableOpacity
                disabled={resendIn > 0 || verifying || checking || checkingBeforeVerify || verifyInFlight.current || sendInFlight.current}
                onPress={handleResend}
                hitSlop={{ top: 18, bottom: 18, left: 12, right: 12 }}
                accessibilityRole="button"
                accessibilityLabel={resendIn > 0 ? `Resend code in ${resendIn} seconds` : 'Resend code'}
                accessibilityState={{ disabled: resendIn > 0 || verifying || checking }}
              >
                {/* gpt vision: while the countdown runs this "visually looks like
                    normal text, not a future action". An outlined pill makes the
                    control legible from the first second, so it is obvious it
                    becomes tappable - the honest disabled state, not a dead word. */}
                <View
                  style={{
                    marginLeft: 8,
                    paddingHorizontal: 12,
                    minHeight: 32,
                    justifyContent: 'center',
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: resendIn > 0 ? colors.outlineVariant : colors.primary,
                    backgroundColor: resendIn > 0 ? 'transparent' : 'rgba(67,67,213,0.08)',
                  }}
                >
                  <Text className="font-inter-600" style={{ fontSize: 14, lineHeight: 18, color: resendIn > 0 ? colors.textSecondary : colors.primary }}>
                    {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
            {/* SECURITY: the dev code is a real OTP for the real account. The
                PROD API currently ships with AUTH_DEV_MODE=1, so it RETURNS a
                live code in the response body - which means a released build
                would put a working login code on screen for any phone number.
                gpt vision flagged it as "a production blocker" and it is one.
                Guarded on __DEV__ so a shipped build cannot show it even while
                the server-side flag is still on. Removing AUTH_DEV_MODE from
                the Vercel env is the server-side half (needs a deploy). */}
            {__DEV__ && devHint && !error ? (
              <Text className="font-inter-500 text-center mt-3" style={{ fontSize: 12, lineHeight: 16, color: colors.tertiary }}>
                {devHint}
              </Text>
            ) : null}
          </>
        )}

        <Modal visible={showCountryPicker} transparent animationType="fade" onRequestClose={() => setShowCountryPicker(false)}>
          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }} activeOpacity={1} onPress={() => setShowCountryPicker(false)}>
            <View style={{ backgroundColor: colors.surfaceContainerLowest, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: 380, paddingTop: 12 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.outlineVariant, alignSelf: 'center', marginBottom: 12 }} />
              <Text className="font-inter-600" accessibilityRole="header" style={{ fontSize: 16, textAlign: 'center', marginBottom: 12, color: colors.textPrimary }}>Select country</Text>
              <FlatList data={COUNTRIES} keyExtractor={(item) => item.code} renderItem={({ item }) => (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 14, backgroundColor: countryCode === item.code ? colors.surfaceContainer : 'transparent' }}
                  onPress={() => selectCountry(item.code)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name}, ${item.code}`}
                  accessibilityState={{ selected: countryCode === item.code }}
                >
                  <Text style={{ fontSize: 20, marginRight: 12 }}>{item.flag}</Text>
                  <Text className="font-inter-400" style={{ flex: 1, fontSize: 15, color: colors.textPrimary }}>{item.name}</Text>
                  <Text className="font-inter-600" style={{ fontSize: 15, color: colors.textPrimary }}>{item.code}</Text>
                </TouchableOpacity>
              )} />
              <View style={{ height: 24 }} />
            </View>
          </TouchableOpacity>
        </Modal>

        {/* THE GIANT EMPTY BAND (gpt vision scored the rhythm 5.5/10 here:
            "the space between Create account and the encryption note is roughly
            half the usable screen... the page suddenly becomes a desert").
            The industry fix is NOT more decoration - it is ONE tight content
            group with the remaining space as deliberate bottom breathing room.
            Measured: first attempt put the note 642px BELOW the CTA because two
            flex-1 spacers split the leftover space and floated it in the middle -
            the void just moved. Now: form -> note -> step dots, then a single
            trailing spacer. */}
        <View className="items-center" accessible={false} importantForAccessibility="no" style={{ marginTop: 28 }}>
          {/* Quiet reassurance, not a status banner. gpt: "the -> YOUR DATA IS
              ENCRYPTED IN TRANSIT treatment feels somewhat like a technical
              status banner... it should feel like quiet reassurance, not a
              fourth section heading" - so: sentence case, no arrow, calmer ink. */}
          <View className="flex-row items-center">
            <ShieldCheckIcon size={12} color="rgba(70,69,85,0.6)" />
            <Text className="font-inter-500 ml-1.5" style={{ fontSize: 12, lineHeight: 16, color: 'rgba(70,69,85,0.62)' }}>
              Your data is encrypted in transit
            </Text>
          </View>
        </View>

        {/* One spacer between the cluster and the indicator, so the cluster is
            tight but the indicator ANCHORS the lower safe area. gpt vision on
            the previous version: "the screen effectively ends around the
            progress indicator, followed by a very large blank field... more
            empty than premium" -> anchor it, do not leave it mid-screen. */}
        <View className="flex-1" />

        <View className="items-center" accessible={false} importantForAccessibility="no" style={{ paddingBottom: 32 + insets.bottom }}>
          <View className="flex-row gap-2">
            {[0, 1].map((index) => (
              <View
                key={index}
                accessibilityRole="text"

                accessibilityLabel={index === 0 ? 'Step 1 of 2, phone number' : 'Step 2 of 2, verification code'}

                className="rounded-full"
                style={{
                  width: 8,
                  height: 8,
                  backgroundColor: (otpSent ? 1 : 0) >= index ? colors.primaryContainer : 'rgba(26,26,46,0.10)',
                }}
              />
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
