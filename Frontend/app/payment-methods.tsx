import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackIcon, CheckIcon } from '../utils/icons';
import { colors, formatPrice } from '../utils/theme';
import { getWallet, syncWalletFromServer } from '../utils/walletStore';
import { useAuth } from '../contexts/AuthContext';

export interface PaymentMethod {
  id: string;
  label: string;
  detail: string;
}

export const PAYMENT_KEY = '@susej_payment';
export const PAYMENT_KEY_BASE = PAYMENT_KEY;

// Session-keyed payment storage (never the app_user blob): a fast account
// switch used to read/write the prior account's payment key, leaking the
// selection across accounts. Callers pass the session username; the
// parameterless path keeps the legacy blob lookup for old call sites.
export function paymentKeyFor(username?: string | null): string {
  const name = String(username ?? '').trim();
  return name ? `${PAYMENT_KEY_BASE}:${name}` : PAYMENT_KEY_BASE;
}

async function getPaymentKey(): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem('app_user');
    if (raw) {
      const u = JSON.parse(raw) as { username?: string };
      const name = typeof u?.username === 'string' ? u.username.trim() : '';
      if (name) return `${PAYMENT_KEY_BASE}:${name}`;
    }
  } catch {}
  return PAYMENT_KEY_BASE;
}

// Industry-standard honesty: only offer rails the platform actually settles.
// Server truth: wallet = atomic server debit; COD = settles on delivery.
// UPI/Card have NO backend settlement path yet - offering them as selectable
// would be fake rails, so UPI renders as an explicitly DISABLED row with the
// reason (no dead tap: tapping explains instead of navigating). Server
// allow-list (wallet/COD) stays fail-closed until a gateway webhook exists.
// Pincode SLA: DeliveryZone has no PIN-prefix columns yet (name/region only),
// so no invented PIN->zone mapping here — the checkout PIN gate + honest ETA
// copy remain the serviceability surface until that model lands (P0-3 NOTE).
export const PAYMENT_METHODS: PaymentMethod[] = [
  { id: 'cod', label: 'Cash on Delivery', detail: 'Pay at your doorstep' },
  { id: 'upi-coming-soon', label: 'UPI (coming soon)', detail: 'No settlement path yet — wallet or COD for now' },
];

export async function getSelectedPayment(username?: string | null): Promise<PaymentMethod | null> {
  try {
    const key = username !== undefined ? paymentKeyFor(username) : await getPaymentKey();
    let raw = await AsyncStorage.getItem(key);
    if (raw === null && key !== PAYMENT_KEY_BASE) {
      const legacy = await AsyncStorage.getItem(PAYMENT_KEY_BASE);
      if (legacy !== null) {
        try { await AsyncStorage.setItem(key, legacy); } catch {}
        raw = legacy;
      }
    }
    return raw ? (JSON.parse(raw) as PaymentMethod) : null;
  } catch {
    return null;
  }
}

export default function PaymentMethodsScreen() {
  const insets = useSafeAreaInsets();
  const { tokenSeq, user } = useAuth();
  const sessionUsername = user?.username ?? null;
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [walletBalance, setWalletBalance] = useState(0);
  // Balance freshness: a failed sync leaves a possibly stale-low cache — the
  // gate must say "couldn't verify", never a false "Empty wallet".
  const [balanceStale, setBalanceStale] = useState(false);
  // Bumped by Retry so the effect below genuinely re-runs (same-route
  // router.replace does not reliably remount this screen).
  const [retrySeq, setRetrySeq] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Server-synced first: the gate below must judge real money, and the
        // row must display it — never a stale cache snapshot.
        const synced = await syncWalletFromServer().catch(() => false);
        const [selected, wallet] = await Promise.all([getSelectedPayment(sessionUsername), getWallet()]);
        if (!active) return;
        if (!synced) setBalanceStale(true);
        // Wallet sits at the top with the live balance; the rest follow.
        const walletMethod: PaymentMethod = { id: 'wallet', label: 'Wallet', detail: `Balance ${formatPrice(wallet.balance)}${!synced ? ' (offline)' : ''}` };
        setWalletBalance(wallet.balance);
        setMethods([walletMethod, ...PAYMENT_METHODS]);
        // Default to the method that can actually pay: an empty wallet as the
        // inherited default guarantees a checkout failure. COD when broke.
        setSelectedId(selected?.id ?? (wallet.balance > 0 ? 'wallet' : 'cod'));
      } catch {
        if (active) setLoadFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [tokenSeq, retrySeq, sessionUsername]);

  const selectMethod = useCallback((method: PaymentMethod) => {
    // UPI has no settlement path yet: never store it as the selection (the
    // server allow-list would reject it at placement). Explain instead of a
    // dead tap or a fake selectable rail.
    if (method.id === 'upi-coming-soon') {
      Alert.alert('UPI is coming soon', 'UPI has no settlement path yet. Pay with wallet or Cash on Delivery for now.');
      return;
    }
    // Numeric gate on the synced balance — never a formatted-string match.
    // Stale (unsynced) balances never false-block: the checkout re-gates on
    // live money at place time anyway.
    if (method.id === 'wallet' && walletBalance <= 0 && !balanceStale) {
      Alert.alert('Empty wallet', 'Add money in the Wallet tab before paying with wallet.');
      return;
    }
    // Persist the selection WITHOUT the balance snapshot: the row detail
    // carries a point-in-time figure ("Balance RsX (offline?)") that later
    // readers could charge/display as current money. Balance always renders
    // from the live sync above; checkout keys on payment.id only.
    const { detail: _staleDetail, ...persistable } = method;
    void _staleDetail;
    void Promise.resolve(paymentKeyFor(sessionUsername)).then((k) => AsyncStorage.setItem(k, JSON.stringify(persistable)).catch(() => {}));
    router.back();
  }, [walletBalance, balanceStale, sessionUsername]);

  return (
    <View className="flex-1 bg-surface">
      {/* Header — h52 safe area */}
      <View className="flex-row items-center justify-between px-5" style={{ height: 52 + insets.top, paddingTop: insets.top }}>
        <TouchableOpacity onPress={() => router.back()}>
          <BackIcon size={16} color={colors.primary} />
        </TouchableOpacity>
        <Text className="text-[20px] font-inter-700" style={{ lineHeight: 28, letterSpacing: -0.5, color: colors.primary }}>
          Payment Method
        </Text>
        <View style={{ width: 16 }} />
      </View>

      {methods === null && !loadFailed && (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.primaryContainer} />
        </View>
      )}

      {loadFailed && (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-[18px] font-inter-600 text-textPrimary mb-2" style={{ lineHeight: 28 }}>
            Couldn't load payment methods
          </Text>
          <TouchableOpacity
            className="px-6 py-3 rounded-full"
            style={{ backgroundColor: colors.primaryContainer }}
            onPress={() => {
              setLoadFailed(false);
              setMethods(null);
              setRetrySeq((s) => s + 1);
            }}
          >
            <Text className="text-[14px] font-inter-600 text-white">Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {methods !== null && (
        <FlatList
          data={methods}
          keyExtractor={(item) => item.id}
          contentContainerClassName="px-5 pb-8"
          contentContainerStyle={{ paddingBottom: insets.bottom + 32, rowGap: 16 }}
          renderItem={({ item }) => {
            const isSelected = item.id === selectedId;
            return (
              <TouchableOpacity
                className="flex-row items-center rounded-[24px] px-4 py-4"
                style={{
                  backgroundColor: colors.surfaceContainerLowest,
                  borderWidth: 1.5,
                  borderColor: isSelected ? colors.primaryContainer : colors.surfaceContainer,
                  shadowColor: colors.textPrimary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.04,
                  shadowRadius: 20,
                  elevation: 2,
                }}
                onPress={() => selectMethod(item)}
              >
                <View className="flex-1">
                  <Text className="text-[15px] font-inter-600 text-textPrimary" style={{ lineHeight: 22 }}>
                    {item.label}
                  </Text>
                  <Text className="text-[13px] font-inter-400 text-textSecondary" style={{ lineHeight: 18 }}>
                    {item.detail}
                  </Text>
                </View>
                {/* Radio */}
                <View
                  className="w-6 h-6 rounded-full items-center justify-center"
                  style={{
                    borderWidth: 2,
                    borderColor: isSelected ? colors.primaryContainer : colors.outlineVariant,
                    backgroundColor: isSelected ? colors.primaryContainer : colors.surfaceContainerLowest,
                  }}
                >
                  {isSelected && <CheckIcon size={12} color={colors.surfaceContainerLowest} />}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View className="items-center justify-center py-20">
              <Text className="text-[16px] font-inter-600 text-textPrimary" style={{ lineHeight: 24 }}>
                No payment methods
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}
