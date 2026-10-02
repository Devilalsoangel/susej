import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, BackHandler } from 'react-native';
import { replaceRoute } from '../../utils/navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeftIcon, ArrowRightIcon } from '../../utils/icons';
import { colors } from '../../utils/theme';
import { interestImages } from '../../utils/screenImages';
import { useAuth } from '../../contexts/AuthContext';
import { serverApi } from '../../utils/serverApi';

const FALLBACK_INTERESTS = [
  'Fashion', 'Electronics', 'Real Estate', 'Food',
  'Beauty', 'Fitness', 'Travel', 'Automotive',
];

function mergeInterests(...groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(name);
    }
  }
  return merged;
}

export default function InterestsScreen() {
  const { user, updateUser, setOnboardingStep } = useAuth();
  const userInterests = useMemo(
    () => mergeInterests(user?.interests ?? []),
    [user?.interests],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [allInterests, setAllInterests] = useState<string[]>(FALLBACK_INTERESTS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const advancing = useRef(false);
  const hydratedInterestsFor = useRef('');
  const visibleInterests = useMemo(
    () => mergeInterests(userInterests, allInterests, FALLBACK_INTERESTS),
    [allInterests, userInterests],
  );
  const hasMin = selected.length >= 3;
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const identity = user?.username?.trim() ?? '';
    if (!identity || hydratedInterestsFor.current === identity) return;
    if (userInterests.length === 0) return;
    hydratedInterestsFor.current = identity;
    setSelected(userInterests);
  }, [user?.username, userInterests]);

  useEffect(() => {
    let alive = true;
    serverApi.getCategories().then((r) => {
      if (!alive || !r.ok || !r.data?.categories?.length) return;
      const names = r.data.categories.map((c: any) => c.name).filter(Boolean);
      if (names.length) setAllInterests(mergeInterests(names, FALLBACK_INTERESTS));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const goToLocation = useCallback(async () => {
    if (advancing.current || saving) return;
    advancing.current = true;
    setSaveError('');
    let failed = false;
    try {
      // Save the picks BEFORE navigating away. They used to live only in
      // component state, so a back gesture discarded every tile the user had
      // ticked, and re-entering showed 0 selected with no warning.
      if (selected.length > 0) {
        const saved = await updateUser({ interests: selected });
        if (saved !== true) {
          setSaveError(saved || 'Could not save your interests. Please try again.');
          failed = true;
          return;
        }
      }
      const stepSaved = await setOnboardingStep(2);
      if (!stepSaved) {
        setSaveError('Could not go back. Please try again.');
        failed = true;
        return;
      }
      const navigated = await replaceRoute('/(onboarding)/location');
      if (!navigated) {
        setSaveError('Could not go back. Please try again.');
        failed = true;
      }
    } catch {
      setSaveError('Could not go back. Please try again.');
      failed = true;
    } finally {
      setSaving(false);
      if (failed) advancing.current = false;
    }
  }, [saving, selected, setOnboardingStep, updateUser]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (saving || advancing.current) return true;
      void goToLocation();
      return true;
    });
    return () => sub.remove();
  }, [goToLocation, saving]);

  const finishInterests = useCallback(async (skip: boolean) => {
    if (advancing.current || saving) return;
    advancing.current = true;
    setSaving(true);
    setSaveError('');
    let failed = false;
    try {
      // "Skip" means "I am done here", NOT "throw away what I picked". The old
      // condition skipped the save whenever skip was set, so a user who chose
      // 5 categories and tapped Skip advanced with an empty, unpersonalised
      // feed and no explanation.
      if (selected.length > 0) {
        const saved = await updateUser({ interests: selected });
        if (saved !== true) {
          setSaveError(saved || 'Could not save your interests. Please try again.');
          failed = true;
          return;
        }
      }
      const stepSaved = await setOnboardingStep(4);
      if (!stepSaved) {
        setSaveError('Could not save your interests progress. Please try again.');
        failed = true;
        return;
      }
      const navigated = await replaceRoute('/(onboarding)/first-feed');
      if (!navigated) {
        setSaveError('Could not open the next step. Please try again.');
        failed = true;
      }
    } catch {
      setSaveError('Could not continue. Please try again.');
      failed = true;
    } finally {
      setSaving(false);
      if (failed) advancing.current = false;
    }
  }, [saving, selected, setOnboardingStep, updateUser]);

  const toggle = (interest: string) => {
    setSelected((prev) =>
      prev.includes(interest) ? prev.filter((i) => i !== interest) : [...prev, interest]
    );
  };

  // Fail closed: Continue, Skip and back all write through the session, so a
  // render without a live user is a full interactive screen whose every control
  // can only ever fail - with the back gesture swallowed on top.
  if (!user) return null;

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      {/* Header */}
      <View
        className="flex-row items-center justify-between px-5"
        style={{ height: 72 + insets.top, paddingTop: insets.top, backgroundColor: colors.surface }}
      >
        {/* Back button circle */}
        <TouchableOpacity
          className="items-center justify-center"
          style={{ width: 40, height: 40, borderRadius: 20 }}
          onPress={goToLocation}
        >
          <ChevronLeftIcon size={16} color={colors.primary} />
        </TouchableOpacity>

        {/* Step counter */}
        <View className="flex-row items-center" style={{ gap: 2 }}>
          <Text
            className="font-inter-500"
            style={{ fontSize: 12, lineHeight: 14, letterSpacing: 0.24, color: colors.textSecondary }}
          >
            Step 07
          </Text>
          <Text
            className="font-inter-500"
            style={{ fontSize: 12, lineHeight: 14, letterSpacing: 0.24, color: colors.outlineVariant }}
          >
            /
          </Text>
          <Text
            className="font-inter-500"
            style={{ fontSize: 12, lineHeight: 14, letterSpacing: 0.24, color: colors.textSecondary }}
          >
            10
          </Text>
        </View>

        {/* Skip */}
        <TouchableOpacity
          onPress={() => void finishInterests(true)}
          disabled={saving}
        >
          <Text
            className="font-inter-600"
            style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.primary }}
          >
            Skip
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false} bounces={false}>
        {/* Heading Section */}
        <View className="px-5 pt-4 pb-6">
          <Text
            className="font-inter-700 mb-2"
            style={{ fontSize: 32, lineHeight: 40, letterSpacing: -0.64, color: colors.textPrimary }}
          >
            What interests you?
          </Text>
          <Text
            className="font-inter-400"
            style={{ fontSize: 16, lineHeight: 24, color: colors.textSecondary }}
          >
            Pick at least 3 categories to personalize your{'\n'}feed and discover exclusive offers.
          </Text>
        </View>

        {/* Bento Grid - 2 columns, 169×160 each */}
        <View className="px-5">
          <View className="flex-row flex-wrap" style={{ gap: 12 }}>
            {visibleInterests.map((interest, i) => {
              const active = selected.includes(interest);
              const tileImage = interestImages.length
                ? interestImages[i % interestImages.length]
                : undefined;
              return (
                <TouchableOpacity
                  key={interest}
                  className="rounded-figma-24 overflow-hidden"
                  style={{
                    width: 169,
                    height: 160,
                    backgroundColor: active ? colors.surfaceContainerHigh : colors.surfaceContainer,
                    borderWidth: active ? 1.5 : 0,
                    borderColor: active ? colors.primaryContainer : 'transparent',
                  }}
                  onPress={() => toggle(interest)}
                >
                  {/* Visual zone (Figma category photo) */}
                  <View
                    className="w-full"
                    style={{ height: 114, backgroundColor: active ? colors.primaryContainer : colors.surfaceContainerHighest }}
                  >
                    {tileImage ? (
                      <Image source={tileImage} className="w-full h-full" resizeMode="cover" />
                    ) : (
                      <View className="w-full h-full" style={{ backgroundColor: colors.surfaceContainerHighest }} />
                    )}
                  </View>
                  {/* Label row */}
                  <View className="flex-row items-center px-3" style={{ height: 46 }}>
                    <View
                      className="w-5 h-5 rounded-full items-center justify-center mr-2"
                      style={{ backgroundColor: active ? colors.primaryContainer : colors.outlineVariant }}
                    >
                      {active && (
                        <Text style={{ fontSize: 10, color: colors.onPrimary, fontWeight: '700' }}>✓</Text>
                      )}
                    </View>
                    <Text
                      className="font-inter-600 flex-1"
                      style={{ fontSize: 14, lineHeight: 16, letterSpacing: 0.14, color: colors.textPrimary }}
                      numberOfLines={1}
                    >
                      {interest}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {/* Footer */}
      <View
        className="px-5 pt-4"
        style={{ paddingBottom: 32 + insets.bottom, backgroundColor: colors.surface }}
      >
        {/* Counter row */}
        <View className="flex-row items-center justify-between mb-3" style={{ height: 14 }}>
          <Text
            className="font-inter-500"
            style={{ fontSize: 12, lineHeight: 14, letterSpacing: 0.24, color: colors.textSecondary }}
          >
            {selected.length} selected
          </Text>
          <Text
            className="font-inter-500"
            style={{ fontSize: 12, lineHeight: 14, letterSpacing: 0.24, color: colors.primary }}
          >
            {!hasMin ? `Select ${3 - selected.length} more` : 'Great choices!'}
          </Text>
        </View>

        {saveError ? (
          <Text
            className="font-inter-500 text-center mb-3"
            style={{ fontSize: 13, lineHeight: 18, color: colors.error }}
          >
            {saveError}
          </Text>
        ) : null}

        <TouchableOpacity
          className="w-full flex-row items-center justify-center rounded-full"
          style={{
            height: 48,
            backgroundColor: hasMin ? colors.primaryContainer : colors.surfaceContainerHighest,
          }}
          disabled={!hasMin || saving}
          onPress={() => void finishInterests(false)}
        >
          <Text
            className="font-inter-600 mr-2"
            style={{
              fontSize: 14,
              lineHeight: 16,
              letterSpacing: 0.14,
              color: hasMin ? colors.onPrimary : colors.outline,
            }}
          >
            {saving ? 'Saving…' : 'Continue'}
          </Text>
          <ArrowRightIcon
            size={10}
            color={hasMin ? colors.onPrimary : colors.outline}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}
