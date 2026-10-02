import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, ActivityIndicator, BackHandler } from 'react-native';
import { router } from 'expo-router';
import { CameraPlusIcon, PencilIcon, ChevronRightIcon, CheckIcon } from '../../utils/icons';
import { colors } from '../../utils/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';
import { serverApi, transportMessage } from '../../utils/serverApi';
import { uploadToServer } from '../../utils/mediaUpload';
import { AVATAR_PRESET_URLS } from '../../utils/avatarPresets';
import { replaceRoute } from '../../utils/navigation';

type NameStatus = 'idle' | 'checking' | 'ok' | 'taken' | 'invalid';

// 10 DISTINCT avatars from the susej set, already hosted (see utils/
// avatarPresets). A tap assigns the hosted URL immediately: no asset resolution,
// no upload, no network dependency - choosing a picture can never fail.
// This replaces presets that were local `require()` ids reused from unrelated
// screens and uploaded on every tap.
const AVATAR_OPTIONS: readonly string[] = AVATAR_PRESET_URLS;

/**
 * Handles the SERVER mints on its own (createUserByPhone -> `user` + the last
 * four digits, ensureAppUsername -> `user` + an id prefix). They are
 * placeholders, not a choice, so a brand-new account must still pick its own.
 * A handle outside this shape was claimed by the user in profile-setup, which
 * is what makes this screen completable for a returning account.
 */
const AUTO_GENERATED_HANDLE = /^user[a-z0-9]{4,12}$/;

/**
 * Upload errors in human copy: wire codes (offline/server-unreachable/HTTP)
 * map through transportMessage; the server's own sentences (503 host text,
 * 415 type text) already tell the truth and pass through verbatim. Raw
 * exception text (fetch failures, native stack traces, multi-line dumps)
 * must NEVER render — it maps to a human sentence instead.
 */
function humanUploadError(msg: string): string {
  const m = String(msg ?? '').trim();
  if (!m) return 'Could not upload that photo. Try another one.';
  if (m === 'offline' || m === 'server-unreachable' || m === 'session-expired' || /^HTTP \d{3}$/.test(m)) {
    return transportMessage(m, 'try again');
  }
  if (/fetch failed|caused by|exception|malformed|nativerequest/i.test(m) || m.includes('\n')) {
    return 'Could not use that image. Try a gallery photo.';
  }
  return m;
}

export default function ProfileSetupScreen() {
  const { user, updateUser, setOnboardingStep, logout } = useAuth();
  const insets = useSafeAreaInsets();
  const serverHandle = typeof user?.username === 'string' ? user.username : '';
  const [name, setName] = useState(user?.name && !/^User \d{4}$/.test(user.name) ? user.name : '');
  const [bio, setBio] = useState(user?.bio ?? '');
  // Pre-filled with a handle the user already CHOSE. The field used to start
  // empty, and Continue requires a valid handle - so any account that landed
  // here with a name but no typed handle had a permanently disabled Continue,
  // a swallowed back gesture, and no way out. That is the sign-in trap.
  const prefillHandle = serverHandle && !AUTO_GENERATED_HANDLE.test(serverHandle) ? serverHandle : '';
  const [username, setUsername] = useState(prefillHandle);
  const [claimedHandle, setClaimedHandle] = useState('');
  const [nameStatus, setNameStatus] = useState<NameStatus>('idle');
  const [avatar, setAvatar] = useState<string | undefined>(user?.avatar);
  // "Remove photo" used to clear local state only, while Continue omitted
  // `avatar` from the PATCH - so the server kept the photo and it reappeared
  // everywhere after saving. The removal has to be SENT, not just undone
  // locally, so it is tracked explicitly and cleared by a new choice.
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [presetId, setPresetId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [checkAttempt, setCheckAttempt] = useState(0);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkSeq = useRef(0);
  const advancing = useRef(false);
  const usernameTouched = useRef(false);
  const effectiveServerHandle = claimedHandle || serverHandle;

  // `user` can land a tick after this screen mounts, so the initial value of
  // `username` is not always available in time. Fill it in once - and never
  // over a handle the user is currently typing.
  useEffect(() => {
    if (usernameTouched.current || username) return;
    if (!prefillHandle) return;
    setUsername(prefillHandle);
  }, [prefillHandle, username]);

  useEffect(() => {
    const seq = ++checkSeq.current;
    if (checkTimer.current) clearTimeout(checkTimer.current);
    const typed = username.trim().toLowerCase();
    if (!typed) {
      setNameStatus('idle');
      return;
    }
    if (!/^[a-z0-9._]{3,20}$/.test(typed)) {
      setNameStatus('invalid');
      return;
    }
    if (typed === effectiveServerHandle.toLowerCase() && effectiveServerHandle) {
      setNameStatus('ok');
      return;
    }
    setNameStatus('checking');
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await serverApi.checkUsername(typed);
        if (seq !== checkSeq.current) return;
        if (!res.ok) {
          setNameStatus('idle');
          return;
        }
        if (res.data?.mine) {
          setClaimedHandle(typed);
          setNameStatus('ok');
          return;
        }
        setNameStatus(res.data?.available ? 'ok' : 'taken');
      } catch {
        if (seq !== checkSeq.current) return;
        setNameStatus('idle');
      }
    }, 600);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [checkAttempt, effectiveServerHandle, username]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // Gallery pick with system crop (square, auto-centered) → upload first so
  // only a hosted URL is ever persisted (local file:// URIs are unviewable
  // on other devices and rejected by the server).
  const pickFromGallery = async () => {
    setPhotoError('');
    try {
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync?.();
      if (perm && perm.granted === false) {
        setPhotoError('Gallery permission is needed to add a photo.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.length) return;
      const uri = String(result.assets[0].uri ?? '');
      if (!uri) return;
      setUploading(true);
      try {
        const hosted = await uploadToServer(uri, result.assets[0].mimeType || 'image/jpeg');
        setAvatar(hosted);
        setAvatarRemoved(false);
        setPresetId(null);
      } catch (e) {
        // Human copy: wire codes map, server sentences pass through.
        const msg = e instanceof Error && e.message ? e.message : '';
        setPhotoError(humanUploadError(msg));
      } finally {
        setUploading(false);
      }
    } catch {
      setPhotoError('Could not open the gallery. Try again.');
    }
  };

  // Preset taps are INSTANT: the set is hosted, so there is no asset registry
  // lookup and no per-tap upload. That matters more than it looks - a profile
  // picture is mandatory, so any failed upload here used to be an inescapable
  // dead end on the only screen that can set one.
  const pickPreset = (index: number) => {
    const url = AVATAR_OPTIONS[index];
    if (!url) return;
    setAvatar(url);
    setAvatarRemoved(false);
    setPresetId(index);
  };


  const typedHandle = username.trim().toLowerCase();
  const usernameValid = /^[a-z0-9._]{3,20}$/.test(typedHandle);
  const retryUsernameCheck = () => {
    if (nameStatus !== 'idle' || !usernameValid) return;
    setCheckAttempt((attempt) => attempt + 1);
  };
  const usernameSettled =
    usernameValid && (nameStatus === 'ok' || (effectiveServerHandle !== '' && typedHandle === effectiveServerHandle.toLowerCase()));
  // A profile picture is REQUIRED, not optional. Every surface in the app
  // renders the user's avatar (feed, chat, store, seller page), so an account
  // without one is an invisible person in their own marketplace. There is no
  // skip path: the photo is the only way past this screen.
  const hasAvatar = Boolean(avatar) && !avatarRemoved;
  const canContinue =
    !uploading &&
    !saving &&
    hasAvatar &&
    name.trim().length > 0 &&
    usernameSettled;

  const continuePressed = async () => {
    if (advancing.current || uploading || saving) return;
    const typed = username.trim().toLowerCase();
    if (!name.trim()) {
      setSaveError('Please enter your name to continue.');
      return;
    }
    if (!usernameValid) {
      setSaveError('Please choose a valid username (3-20 characters: letters, numbers, dots, underscores).');
      return;
    }
    if (!usernameSettled) {
      setSaveError(
        nameStatus === 'taken'
          ? 'That username is already taken.'
          : nameStatus === 'checking'
            ? 'Checking your username — try again in a moment.'
            : 'Waiting for username check — try again in a moment.'
      );
      return;
    }
    advancing.current = true;
    setSaving(true);
    setSaveError('');
    let failed = false;
    try {
      const claimedNow = typed !== effectiveServerHandle.toLowerCase();
      if (claimedNow) {
        const claim = await serverApi.claimUsername(typed);
        if (!claim.ok) {
          const recovery = await serverApi.getMe();
          const recoveredHandle =
            recovery.ok && typeof recovery.data?.user?.username === 'string'
              ? recovery.data.user.username.trim().toLowerCase()
              : '';
          if (recoveredHandle !== typed) {
            setSaveError(claim.error ?? 'That username is already taken.');
            failed = true;
            return;
          }
        }
        setClaimedHandle(typed);
      }
      const identity = await serverApi.getMe();
      if (!identity.ok) {
        setSaveError('Username saved, but we could not refresh your profile yet. Tap Continue to retry.');
        failed = true;
        return;
      }
      const remoteUser = identity.data?.user;
      const remoteHandle =
        typeof remoteUser?.username === 'string' ? remoteUser.username.trim().toLowerCase() : '';
      if (remoteHandle !== typed) {
        setSaveError(
          remoteHandle
            ? 'Username saved, but the server still shows a different handle. Tap Continue to retry.'
            : 'Username saved, but we could not confirm it yet. Tap Continue to retry.',
        );
        failed = true;
        return;
      }
      const saved = await updateUser({
        username: remoteHandle,
        name: name.trim(),
        ...(bio.trim() ? { bio: bio.trim().slice(0, 150) } : {}),
        // A removal has to be transmitted; omitting the key is what made
        // "Remove photo" a lie the user only discovered after saving.
        ...(avatarRemoved ? { avatar: '' } : avatar ? { avatar } : {}),
      });
      if (saved !== true) {
        setSaveError(
          claimedNow
            ? 'Your username was claimed, but this app could not switch to it yet. Tap Continue to retry.'
            : saved || 'Could not save your profile. Please try again.',
        );
        failed = true;
        return;
      }
      // Prove the photo is really on the server before moving on. A profile
      // picture is mandatory, so "the screen says it saved" is not good enough:
      // the client used to apply the avatar optimistically, which meant a photo
      // could live only in the local envelope, look fine on this device, and be
      // missing from every other device and every later sign-in.
      if (hasAvatar) {
        const confirmed = await serverApi.getMe();
        const storedAvatar = confirmed.ok
          ? (confirmed.data?.user?.avatar ?? '')
          : '';
        if (typeof storedAvatar !== 'string' || !storedAvatar.trim()) {
          setSaveError(
            'Your photo did not save to our server. Check your connection and tap Continue to retry.',
          );
          failed = true;
          return;
        }
      }
      const stepSaved = await setOnboardingStep(2);
      if (!stepSaved) {
        setSaveError('Could not save your profile progress. Please try again.');
        failed = true;
        return;
      }
      const navigated = await replaceRoute('/(onboarding)/location');
      if (!navigated) {
        setSaveError('Could not open the next step. Please try again.');
        failed = true;
      }
    } catch {
      setSaveError('Could not save your profile. Please try again.');
      failed = true;
    } finally {
      setSaving(false);
      if (failed) advancing.current = false;
    }
  };

  // Fail closed: Continue claims a handle and writes the profile, so a render
  // without a live user is a screen whose only exit can never succeed - and the
  // back gesture is swallowed, so there is no way out at all.
  if (!user) return null;

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      {/* Header */}
      <View className="flex-row items-center h-[62px] px-5" style={{ backgroundColor: colors.surface, height: 62 + insets.top, paddingTop: insets.top }}>
        <View style={{ width: 18 }} />
        <Text
          className="flex-1 text-center font-inter-700"
          style={{ fontSize: 20, lineHeight: 28, letterSpacing: -0.5, marginRight: 18, color: colors.primary }}
        >
          susej
        </Text>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        {/* Progress Indicators - 5 of 6.
            The remaining step used surfaceContainer (#efecff) on a #fcf8ff page,
            which is ~1.1:1 - so the "not yet done" segment was effectively
            INVISIBLE. Both gpt vision ("the progress bar shows 5 completed
            segments and 1 remaining") and my pixel-geometry tool only ever saw
            five bars, and the tool's band even looked off-centre because the
            sixth one never registered. outlineVariant (#c7c4d7) is the token for
            a visible inactive track. */}
        <View className="flex-row gap-2 mb-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <View
              key={i}
              className="flex-1 h-1.5 rounded-full"
              style={{ backgroundColor: i < 5 ? colors.primaryContainer : colors.outlineVariant }}
            />
          ))}
        </View>

        {/* Header Content */}
        <Text
          className="font-inter-700 mb-2"
          style={{ fontSize: 32, lineHeight: 40, letterSpacing: -0.64, color: colors.textPrimary }}
        >
          Set up your profile
        </Text>
        <Text
          className="font-inter-400 mb-8"
          style={{ fontSize: 16, lineHeight: 24, color: colors.textSecondary }}
        >
        {/* gpt vision: "the subtitle wraps into two lines, but the second line
            only contains 'susej.' - it feels slightly accidental." The hardcoded
            newline forced that orphan, so the copy now fits on one line. */}
        Tell us a bit about yourself to get started.
        </Text>

        <View className="items-center mb-8">
          <TouchableOpacity className="relative mb-3" activeOpacity={0.7} onPress={pickFromGallery} disabled={uploading}>
            <View
              className="w-[100px] h-[100px] rounded-full items-center justify-center overflow-hidden"
              style={{ backgroundColor: avatar ? 'transparent' : '#efecff' }}
            >
              {avatar ? (
                <Image source={{ uri: avatar }} className="w-full h-full" resizeMode="cover" />
              ) : uploading ? (
                <ActivityIndicator size="large" color={colors.primary} />
              ) : (
                <CameraPlusIcon size={44} color={colors.primary} />
              )}
            </View>
            <View
              className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full items-center justify-center"
              style={{ backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.surface }}
            >
              <PencilIcon size={12} color="#FFFFFF" />
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={pickFromGallery} disabled={uploading}>
            <Text
              className="font-inter-600"
              style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.primary }}
            >
              {uploading ? 'Uploading…' : avatar ? 'Change Photo' : 'Add Photo'}
            </Text>
          </TouchableOpacity>
          <Text
            className="font-inter-500 mt-1 text-center"
            style={{ fontSize: 12, lineHeight: 16, color: colors.textSecondary }}
          >
            {/* gpt vision, on both passes: the tile says "Add Photo" and the copy
              said "This step cannot be skipped", but a PRESET AVATAR satisfies the
              requirement just as well - so the wording implied a real photo was
              compulsory and made an avatar feel like a lesser fallback. Stated
              as one fact, with both routes and the reason. The requirement itself
              is still enforced honestly by the disabled Continue button. */}
          Your photo appears on every post, chat and shop. Add a photo or pick an avatar below to continue.
          </Text>
          {photoError ? (
            <Text
              className="font-inter-500 mt-2 text-center"
              style={{ fontSize: 12, lineHeight: 16, color: colors.error }}
            >
              {photoError}
            </Text>
          ) : null}

          {/* Avatar presets — always visible, no dropdown. */}
          <View className="w-full mt-5 rounded-figma-16 p-4" style={{ backgroundColor: colors.surfaceContainerLow }}>
            <Text
              className="font-inter-600 mb-3"
              style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.textSecondary }}
            >
              Or pick an avatar
            </Text>
            <View className="flex-row flex-wrap justify-center gap-[10px]">
              {AVATAR_OPTIONS.map((url, index) => {
                // Compare the preset INDEX, not the image URI: a gallery photo
                // and a previously-saved server value both mean "no preset
                // chosen", while the index says exactly which tile is active.
                const selected = index === presetId || (presetId === null && avatar === url);
                return (
                  <TouchableOpacity
                    key={url}
                    className="w-[52px] h-[52px] rounded-full items-center justify-center"
                    style={{
                      borderWidth: selected ? 3 : 0,
                      borderColor: selected ? colors.primaryContainer : 'transparent',
                    }}
                    activeOpacity={0.7}
                    onPress={() => pickPreset(index)}
                      accessibilityRole="button"
                      accessibilityLabel={`Avatar ${index + 1} of ${AVATAR_OPTIONS.length}`}
                      accessibilityState={{ selected }}
                    >
                      <Image source={{ uri: url }} className="w-[46px] h-[46px] rounded-full" resizeMode="cover" />
                      {/* gpt vision (twice): the ring alone is "close to the avatar
                          edge" and a thicker ring or a small check badge would make
                          the choice obvious at a glance - "a user can tap and
                          wonder if it registered". */}
                      {selected ? (
                        <View className="absolute bottom-0 right-0 w-[18px] h-[18px] rounded-full items-center justify-center" style={{ backgroundColor: colors.primary }}>
                          <CheckIcon size={11} color="#FFFFFF" />
                        </View>
                      ) : null}
                    </TouchableOpacity>
                );
              })}
            </View>
            {avatar ? (
              <TouchableOpacity className="self-center mt-4" onPress={() => {
                setAvatar(undefined);
                setAvatarRemoved(true);
                setPresetId(null);
              }}>
                <Text
                  className="font-inter-600"
                  style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.textSecondary }}
                >
                  Remove photo
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* Full Name */}
        <View className="mb-4">
          <Text
            className="font-inter-600 mb-2"
            style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.textSecondary }}
          >
            Full Name
          </Text>
          <View
            className="h-[56px] px-4 rounded-figma-16 justify-center"
            style={{ backgroundColor: colors.surfaceContainerHigh, borderWidth: 1, borderColor: colors.outlineVariant }}
          >
            <TextInput
              className="font-inter-400"
              style={{ fontSize: 16, color: colors.textPrimary }}
              placeholder="Enter your name"
              placeholderTextColor="rgba(70,69,85,0.7)"
              value={name}
              onChangeText={setName}
              maxLength={80}
            />
          </View>
        </View>

        {/* Username — free choice, checked live against the DB (industry
            standard: no two accounts share a handle). Claimed on Continue. */}
        <View className="mb-4">
          <Text
            className="font-inter-600 mb-2"
            style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.textSecondary }}
          >
            Username
          </Text>
          <View
            className="flex-row items-center h-[56px] px-4 rounded-figma-16"
            style={{
              backgroundColor: colors.surfaceContainerHigh,
              // Resting state gets a visible border too (the field used to be
              // invisible against the page). The nameStatus branch still wins
              // when the username is taken/invalid.
              borderWidth: nameStatus === 'taken' || nameStatus === 'invalid' ? 1.5 : 1,
              borderColor: nameStatus === 'taken' || nameStatus === 'invalid' ? colors.error : colors.outlineVariant,
            }}
          >
            <Text
              className="font-inter-400"
              style={{ fontSize: 16, lineHeight: 24, color: colors.textSecondary }}
            >
              @
            </Text>
            <TextInput
              className="flex-1 ml-1 font-inter-400"
              style={{ fontSize: 16, color: colors.textPrimary }}
              placeholder="username"
              placeholderTextColor="rgba(70,69,85,0.7)"
              value={username}
              onChangeText={(t) => {
                usernameTouched.current = true;
                setUsername(t.toLowerCase().replace(/[^a-z0-9._]/g, ''));
              }}
              onPressIn={retryUsernameCheck}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
            />
            {nameStatus === 'checking' ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : nameStatus === 'ok' ? (
              <Text style={{ fontSize: 18, color: '#16a34a' }}>✓</Text>
            ) : nameStatus === 'taken' || nameStatus === 'invalid' ? (
              <Text style={{ fontSize: 18, color: colors.error }}>✕</Text>
            ) : null}
          </View>
          <Text
            className="font-inter-400 mt-2"
            style={{
              fontSize: 12,
              lineHeight: 16,
              color:
                nameStatus === 'taken' || nameStatus === 'invalid'
                  ? colors.error
                  : colors.textSecondary,
            }}
          >
            {nameStatus === 'taken'
              ? 'That username is already taken.'
              : nameStatus === 'invalid'
                ? 'Use 3-20 characters: lowercase letters, numbers, dots, underscores.'
                : nameStatus === 'checking'
                  ? 'Checking availability…'
                  : nameStatus === 'idle' && usernameValid
                    ? 'Could not check availability. Tap the username field to retry.'
                    : 'Your unique public handle — no two accounts share one.'}
          </Text>
        </View>

        {/* Bio (optional, Instagram pattern with counter). */}
        <View className="mb-6">
          <View className="flex-row items-center justify-between mb-2">
            <Text
              className="font-inter-600"
              style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.textSecondary }}
            >
              Bio
            </Text>
            <Text style={{ fontSize: 12, color: colors.textSecondary }}>{bio.trim().length}/150</Text>
          </View>
          <View
            className="px-4 py-3 rounded-figma-16"
            style={{ backgroundColor: colors.surfaceContainerHigh, borderWidth: 1, borderColor: colors.outlineVariant, minHeight: 88 }}
          >
            <TextInput
              className="font-inter-400"
              style={{ fontSize: 16, color: colors.textPrimary, textAlignVertical: 'top' }}
              placeholder="Tell people what you love…"
              placeholderTextColor="rgba(70,69,85,0.7)"
              value={bio}
              onChangeText={(t) => setBio(t.slice(0, 150))}
              multiline
              numberOfLines={3}
              maxLength={150}
            />
          </View>
        </View>

        {/* Save error — never advance silently. */}
        {saveError ? (
          <Text
            className="font-inter-500 text-center mb-3"
            style={{ fontSize: 13, lineHeight: 18, color: colors.error }}
          >
            {saveError}
          </Text>
        ) : null}

        {/* Continue is HIDDEN, not dimmed, until a profile picture exists: a
            permanently greyed button is what made this step feel broken. The
            requirement is stated instead, with the two ways to satisfy it. */}
        {hasAvatar ? (
          <TouchableOpacity
            className="w-full h-14 flex-row items-center justify-center rounded-figma-16 mb-4"
            style={{ backgroundColor: colors.primary, opacity: canContinue ? 1 : 0.5 }}
            onPress={continuePressed}
            disabled={!canContinue}
          >
            <Text
              className="font-inter-600 mr-2"
              style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: '#FFFFFF' }}
            >
              {saving ? 'Saving…' : 'Continue'}
            </Text>
            {!saving && <ChevronRightIcon size={16} color="#FFFFFF" />}
          </TouchableOpacity>
        ) : null}

        {/* A blocked step must say WHY. */}
        {!canContinue && !saving ? (
          <Text
            className="font-inter-500 text-center mb-4"
            style={{ fontSize: 13, lineHeight: 18, color: colors.textSecondary }}
          >
            {uploading
              ? 'Finishing your photo…'
              : !hasAvatar
                ? 'Add a photo or pick an avatar above — this step cannot be skipped.'
                : !name.trim()
                  ? 'Add your name to continue.'
                  : nameStatus === 'taken'
                    ? 'That username is taken — pick another.'
                    : !usernameValid
                      ? 'Choose a username to continue.'
                      : 'Checking your username — one moment.'}
          </Text>
        ) : null}

        {/* The escape hatch. This screen is a hard block (no picture, no
            Continue, and the root gate routes every other route back here), so
            without a way out a user whose upload keeps failing is TRAPPED -
            and signing out lives on the Profile tab this block prevents them
            from ever reaching. */}
        <TouchableOpacity
          className="items-center mb-6"
          onPress={() => void logout()}
          disabled={saving || uploading}
          accessibilityRole="button"
        >
          <Text
            className="font-inter-500"
            style={{ fontSize: 13, lineHeight: 18, color: colors.textSecondary }}
          >
            Sign out
          </Text>
        </TouchableOpacity>

        {/* Terms */}
        <Text
          className="font-inter-500 text-center mb-8"
          style={{ fontSize: 12, lineHeight: 20, letterSpacing: 0.24, color: 'rgba(70,69,85,0.6)' }}
        >
          By continuing, you agree to our{' '}
          <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => router.push('/terms')}>
            Terms of Service
          </Text>
          {'\n'}and{' '}
          <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => router.push('/privacy')}>
            Privacy Policy
          </Text>.
        </Text>
      </ScrollView>
    </View>
  );
}
