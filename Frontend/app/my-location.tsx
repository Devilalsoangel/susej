import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ChevronLeftIcon, CheckIcon } from '../utils/icons';
import { colors } from '../utils/theme';
import { useAuth } from '../contexts/AuthContext';
import { MapLocationPicker, type PickedLocation } from '../components/MapLocationPicker';
import { serverApi } from '../utils/serverApi';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Only the fields this screen needs, from the server-backed address book. */
interface PlaceRow {
  id: string;
  name: string;
  street: string;
  city: string;
}

/**
 * /my-location - set or change your browsing location, any time, from inside
 * the app.
 *
 * WHY THIS SCREEN EXISTS (the gap, in evidence):
 *  - The only place a buyer could pick a location was the ONBOARDING funnel
 *    (app/(onboarding)/location.tsx). Once onboarding finished, the step guard
 *    (utils/navigation.ts ONBOARDING_STEP_ROUTES) made that screen unreachable,
 *    so a user who skipped it - or picked the wrong city - was stuck forever.
 *  - The one other write is `app/edit-profile.tsx` "Business Address", which is
 *    inside a `{user?.isSeller && ...}` gate: a buyer never sees it, and it
 *    overwrites the browsing city with a shop address.
 *  - Settings even had a ready-made, correctly-labelled "Location" row - and it
 *    was never rendered (dead `PERMS` array, no JSX reference).
 *
 * It deliberately reuses what is already proven rather than inventing a second
 * selector: MapLocationPicker (map + drop-a-pin + live Nominatim search +
 * GPS) and the server-backed address book for one-tap switches.
 */
export default function MyLocationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, updateUser } = useAuth();

  const current = typeof user?.location === 'string' ? user.location.trim() : '';
  const [picked, setPicked] = useState<PickedLocation | null>(
    current ? { lat: 0, lng: 0, label: current } : null,
  );
  const [addresses, setAddresses] = useState<PlaceRow[]>([]);
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');

  // Saved delivery addresses double as one-tap location choices, which is what
  // makes this Swiggy-like: the places you deliver to ARE the places you browse.
  // Read from the same server-backed source the address book uses, rather than
  // duplicating its local-mirror logic.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await serverApi.getAddresses();
        if (cancelled) return;
        const rows = res.ok && Array.isArray(res.data?.addresses) ? res.data.addresses : [];
        setAddresses(
          rows
            .map((a) => ({ id: String(a.id), name: String(a.name ?? ''), street: String(a.street ?? ''), city: String(a.city ?? '') }))
            .filter((a) => a.city.trim().length > 0),
        );
      } catch {
        if (!cancelled) setAddresses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chosen = picked?.label ?? current;
  const canSave = Boolean(chosen) && state !== 'saving' && chosen !== current;

  const save = useCallback(async () => {
    const label = picked?.label?.trim();
    if (!label || state === 'saving') return;
    setState('saving');
    setError('');
    const res = await updateUser({ location: label });
    if (res === true) {
      setState('saved');
      // Give the confirmation a beat so it is actually seen, then go back to
      // wherever the user came from.
      setTimeout(() => router.back(), 650);
    } else {
      setState('error');
      setError(typeof res === 'string' && res ? res : 'Could not save your location. Please try again.');
    }
  }, [picked, router, state, updateUser]);

  const cityOf = useCallback((addr: PlaceRow) => {
    // Saved city is stored as "City, PIN" - the city is the part before the pin.
    return addr.city.split(',')[0].trim() || addr.city.trim();
  }, []);

  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; title: string; sub: string; onPress: () => void; active: boolean }> = [];
    if (current) {
      out.push({
        key: 'current',
        title: current,
        sub: 'Your current location',
        onPress: () => setPicked({ lat: 0, lng: 0, label: current }),
        active: !picked || picked.label === current,
      });
    }
    for (const addr of addresses) {
      const city = cityOf(addr);
      if (!city) continue;
      const key = `${addr.id}`;
      if (seen.has(city.toLowerCase())) continue;
      seen.add(city.toLowerCase());
      out.push({
        key,
        title: city,
        sub: addr.street ? `${addr.name} · ${addr.street}` : addr.name,
        onPress: () => setPicked({ lat: 0, lng: 0, label: city }),
        active: picked?.label === city,
      });
    }
    return out.slice(0, 6);
  }, [addresses, cityOf, current, picked]);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.topBar}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <ChevronLeftIcon size={20} color={colors.primary} />
        </TouchableOpacity>
        <Text className="font-inter-700" style={styles.topTitle} accessibilityRole="header">
          Your location
        </Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* What is stored today. Before this screen a user who skipped
            onboarding had no way to see or change this at all. */}
        <View style={styles.currentCard}>
          <Text className="font-inter-500" style={styles.cardEyebrow}>
            {current ? 'Browsing near' : 'No location set'}
          </Text>
          <Text className="font-inter-700" style={styles.cardTitle} numberOfLines={2}>
            {current || 'Pick a city, drop a pin, or choose a saved address'}
          </Text>
        </View>

        {/* Saved addresses as one-tap switches - the Swiggy pattern: the places
            you deliver to are the places you browse. */}
        {suggestions.length > 0 ? (
          <View style={styles.block}>
            <Text className="font-inter-600" style={styles.blockTitle} accessibilityRole="header">
              {current ? 'Switch to' : 'Your saved places'}
            </Text>
            {suggestions.map((s) => (
              <TouchableOpacity
                key={s.key}
                style={[styles.suggestRow, s.active && styles.suggestRowActive]}
                onPress={s.onPress}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${s.title}, ${s.sub}`}
                accessibilityState={{ selected: s.active }}
              >
                <View style={styles.suggestTextWrap}>
                  <Text className="font-inter-500" style={styles.suggestTitle} numberOfLines={1}>
                    {s.title}
                  </Text>
                  <Text className="font-inter-400" style={styles.suggestSub} numberOfLines={1}>
                    {s.sub}
                  </Text>
                </View>
                {s.active ? (
                  <View style={styles.check}>
                    <CheckIcon size={12} color="#FFFFFF" />
                  </View>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* Map + live search + GPS. The same proven selector used at
            become-seller, now reachable after onboarding. */}
        <View style={styles.block}>
          <Text className="font-inter-600" style={styles.blockTitle} accessibilityRole="header">
            Or choose on the map
          </Text>
          <MapLocationPicker value={picked} onChange={setPicked} height={260} />
        </View>

        {error ? (
          <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </ScrollView>

      {/* Save is pinned so it is always reachable, however far the user scrolled
          to find a place. */}
      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <TouchableOpacity
          style={[styles.saveBtn, !canSave && styles.saveBtnOff]}
          onPress={() => void save()}
          disabled={!canSave}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={chosen ? `Save location, ${chosen}` : 'Save location'}
          accessibilityState={{ disabled: !canSave, busy: state === 'saving' }}
        >
          {state === 'saving' ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text className="font-inter-600" style={styles.saveText}>
              {state === 'saved' ? 'Location saved' : 'Save location'}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceContainerLowest },
  topBar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topTitle: { flex: 1, textAlign: 'center', fontSize: 18, lineHeight: 24, color: colors.textPrimary },
  scroll: { flex: 1, paddingHorizontal: 20 },
  currentCard: {
    borderRadius: 20,
    padding: 16,
    backgroundColor: colors.surfaceContainer,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  cardEyebrow: { fontSize: 12, lineHeight: 16, color: colors.textSecondary },
  cardTitle: { fontSize: 20, lineHeight: 26, marginTop: 4, color: colors.textPrimary },
  block: { marginTop: 24 },
  blockTitle: { fontSize: 15, lineHeight: 20, marginBottom: 10, color: colors.textPrimary },
  suggestRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    marginBottom: 8,
  },
  suggestRowActive: { borderColor: colors.primary, backgroundColor: 'rgba(93,95,239,0.07)' },
  suggestTextWrap: { flex: 1, marginRight: 10 },
  suggestTitle: { fontSize: 15, lineHeight: 20, color: colors.textPrimary },
  suggestSub: { fontSize: 12, lineHeight: 16, marginTop: 2, color: colors.textSecondary },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  error: { marginTop: 16, fontSize: 13, lineHeight: 18, color: colors.error },
  footer: { paddingHorizontal: 20, paddingTop: 12 },
  saveBtn: {
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  saveBtnOff: { backgroundColor: 'rgba(93,95,239,0.42)' },
  saveText: { fontSize: 15, lineHeight: 20, color: '#FFFFFF' },
});
