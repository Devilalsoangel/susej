import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, Image, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackIcon } from '../utils/icons';
import { colors, formatPrice } from '../utils/theme';
import { useCart } from '../contexts/CartContext';
import { usePosts } from '../contexts/PostContext';
import { useAuth } from '../contexts/AuthContext';
import { serverApi } from '../utils/serverApi';
import { resolveListingImage } from '../utils/productImages';

interface BundleItem {
  listingId: string;
  name: string;
  price: number;
  seller: string;
  sellerUsername: string;
}

interface Bundle {
  id: string;
  title: string;
  tagline: string;
  originalPrice: number;
  bundlePrice: number;
  thumbnails: string[];
  items: BundleItem[];
}

const thumbSource = (key: string) =>
  key.startsWith('__listing_')
    ? resolveListingImage(null, key.slice('__listing_'.length) || 'bundle')
    : { uri: key };

const savePct = (bundle: Bundle) => {
  const originalSum = bundle.items.reduce((sum, i) => sum + i.price, 0);
  if (originalSum <= 0) return 0;
  return Math.round(((originalSum - bundle.bundlePrice) / originalSum) * 100);
};

export default function BundlesScreen() {
  const insets = useSafeAreaInsets();
  const { addToCart } = useCart();
  const { posts } = usePosts();
  const [loading, setLoading] = useState(true);
  const [serverBundles, setServerBundles] = useState<any[]>([]);

  const refreshBundles = useCallback(async () => {
    try {
      const res = await serverApi.getBundles();
      if (res.ok && res.data?.bundles) setServerBundles(res.data.bundles);
    } catch {
      // offline: honest empty state below
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void refreshBundles();
    }, [refreshBundles])
  );

  const postById = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of posts as any[]) m.set(p.id, p);
    return m;
  }, [posts]);

  // Server rows -> render cards. Item images resolve from the live feed when
  // the listing is in memory, else the deterministic listing placeholder.
  // Legacy rows without items link the seller's shop instead of cart.
  const bundles: Bundle[] = useMemo(
    () =>
      serverBundles.map((b) => {
        const rawItems: any[] = Array.isArray(b.items) ? b.items : [];
        const items: BundleItem[] = rawItems.map((i) => {
          const post = postById.get(String(i.listingId ?? ''));
          return {
            listingId: String(i.listingId ?? ''),
            name: String(i.name ?? ''),
            price: Number(i.price ?? 0),
            seller: b.sellerName,
            sellerUsername: post?.sellerUsername ?? '',
          };
        });
        const thumbs = items
          .map((i) => {
            const post = postById.get(i.listingId);
            const img = post?.images?.[0] ?? post?.image;
            return typeof img === 'string' && img ? img : null;
          })
          .filter((u): u is string => !!u);
        while (thumbs.length < Math.min(3, Math.max(items.length, 1))) thumbs.push('');
        const originalPrice = b.discount > 0 && b.discount < 100 ? Math.round(Number(b.price) / (1 - Number(b.discount) / 100)) : Number(b.price);
        return {
          id: b.id,
          title: b.title,
          tagline: `${b.sellerName ?? 'Combo'} · ${b.discount}% off combo`,
          originalPrice,
          bundlePrice: Number(b.price),
          thumbnails: thumbs.slice(0, 3).map((u, i) => (u || `__listing_${items[i]?.listingId ?? b.id}_${i}`)),
          items,
        };
      }),
    [serverBundles, postById]
  );

  const addBundle = async (bundle: Bundle) => {
    // Resolve owners for listings missing from the local cache (cached first,
    // server per missing id): '' sellerUsernames sail past the single-seller
    // guard and die as server 400s. Unresolvable stays out with an explanation.
    const missing = [...new Set(bundle.items.filter((i) => !i.sellerUsername).map((i) => i.listingId))];
    const resolved = new Map<string, string>();
    await Promise.all(
      missing.map(async (lid) => {
        try {
          const res = await serverApi.getPost(lid);
          const p = (res.data as { post?: { authorUsername?: unknown; sellerUsername?: unknown } } | null)?.post;
          const owner = String(p?.authorUsername ?? p?.sellerUsername ?? '');
          if (res.ok && owner) resolved.set(lid, owner);
        } catch {}
      })
    );
    const items = bundle.items.map((i) => ({ ...i, sellerUsername: i.sellerUsername || resolved.get(i.listingId) || '' }));
    const unknown = items.filter((i) => !i.sellerUsername);
    if (unknown.length > 0) {
      Alert.alert('Seller unavailable', 'One item in this combo could not be linked to its seller. Check your connection and try again.');
      return;
    }
    // Atomicity pre-check: every line must belong to ONE seller BEFORE the
    // first addToCart — otherwise a cross-seller row leaves a partial combo
    // (split pricing for n items, only k landed) with no undo.
    const owners = [...new Set(items.map((i) => i.sellerUsername.toLowerCase()))];
    if (owners.length > 1) {
      Alert.alert('Combo unavailable', 'The items in this combo belong to different sellers. This bundle needs a fix — try another one.');
      return;
    }
    const n = items.length;
    const share = n > 0 ? Math.floor(bundle.bundlePrice / n) : 0;
    let rejected = false;
    items.forEach((item, i) => {
      const ok = addToCart({
        listingId: item.listingId,
        type: 'product',
        name: item.name,
        price: i === 0 ? bundle.bundlePrice - share * (n - 1) : share,
        seller: item.seller,
        sellerUsername: item.sellerUsername,
        // Bundle membership rides to the server, which re-prices from the
        // Bundle row — the split here is the buyer's preview, never the charge.
        bundleId: bundle.id,
      });
      if (!ok) rejected = true;
    });
    // Single-seller guard surfaced (never a silent no-op + blind navigate).
    if (rejected) {
      Alert.alert('Different seller', 'Your cart has items from another seller. Checkout or clear it first to add this combo.');
      return;
    }
    router.push('/cart');
  };

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      {/* Header */}
      <View
        className="flex-row items-center px-5"
        style={{ height: 52 + insets.top, paddingTop: insets.top, backgroundColor: colors.surface }}
      >
        <TouchableOpacity onPress={() => router.back()} className="mr-3">
          <BackIcon size={16} color={colors.primary} />
        </TouchableOpacity>
        <Text className="flex-1 font-inter-700" style={{ fontSize: 20, lineHeight: 28, letterSpacing: -0.5, color: colors.textPrimary }}>
          Bundle Deals
        </Text>
        <View className="w-5" />
      </View>

      <ScrollView className="flex-1 px-5" contentContainerClassName="pb-24">
        <Text className="font-inter-400 mt-2 mb-4 text-textSecondary" style={{ fontSize: 13, lineHeight: 18 }}>
          Hand-picked combos at a better price — one tap adds the whole set.
        </Text>
        <BundleComposer onPublished={() => refreshBundles()} />
        {loading && bundles.length === 0 && (
          <View className="items-center py-16">
            <ActivityIndicator size="large" color={colors.primaryContainer} />
          </View>
        )}
        {!loading && bundles.length === 0 && (
          <View className="items-center py-16 px-8">
            <Text className="font-inter-500 text-textSecondary text-center" style={{ fontSize: 14, lineHeight: 20 }}>
              No bundle deals right now. Check back soon — sellers bundle bestsellers here.
            </Text>
          </View>
        )}
        {bundles.map((bundle) => {
          const pct = savePct(bundle);
          return (
            <View
              key={bundle.id}
              className="rounded-[24px] p-4 mb-4"
              style={{ backgroundColor: colors.surfaceContainerLowest, shadowColor: colors.textPrimary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.04, shadowRadius: 20, elevation: 3 }}
            >
              {/* Thumbnail row */}
              <View className="flex-row" style={{ gap: 8 }}>
                {bundle.thumbnails.slice(0, 3).map((t, i) => (
                  <Image
                    key={`${bundle.id}_${i}`}
                    source={thumbSource(t)}
                    className="rounded-[12px]"
                    style={{ width: 84, height: 84, backgroundColor: colors.surfaceContainerLow }}
                  />
                ))}
              </View>
              {/* Title + Save badge */}
              <View className="flex-row items-center mt-3">
                <Text className="flex-1 font-inter-600 text-textPrimary mr-2" style={{ fontSize: 16, lineHeight: 22, letterSpacing: 0.14 }} numberOfLines={1}>
                  {bundle.title}
                </Text>
                <View className="px-2.5 py-1 rounded-full" style={{ backgroundColor: colors.tertiary }}>
                  <Text className="text-white font-inter-600" style={{ fontSize: 11, lineHeight: 14 }}>
                    Save {pct}%
                  </Text>
                </View>
              </View>
              <Text className="font-inter-400 text-textSecondary mt-1" style={{ fontSize: 13, lineHeight: 18 }}>
                {bundle.items.length > 0 ? `${bundle.items.length} items · ${bundle.tagline}` : bundle.tagline}
              </Text>
              {/* Price row */}
              <View className="flex-row items-baseline mt-2" style={{ gap: 8 }}>
                <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 14, lineHeight: 20, textDecorationLine: 'line-through' }}>
                  {formatPrice(bundle.originalPrice)}
                </Text>
                <Text className="font-inter-700" style={{ fontSize: 20, lineHeight: 28, color: colors.primaryContainer }}>
                  {formatPrice(bundle.bundlePrice)}
                </Text>
              </View>
              {/* CTA */}
              {bundle.items.length > 0 ? (
                <TouchableOpacity
                  className="w-full items-center justify-center mt-4"
                  style={{ height: 48, borderRadius: 16, backgroundColor: colors.primaryContainer }}
                  onPress={() => addBundle(bundle)}
                >
                  <Text className="text-white font-inter-600" style={{ fontSize: 15, lineHeight: 20 }}>
                    Add bundle to cart
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text className="font-inter-400 text-textSecondary mt-4" style={{ fontSize: 13, lineHeight: 18 }}>
                  Curated by {bundle.tagline.split('·')[0]?.trim() ?? 'the seller'} — message them for the full set.
                </Text>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Seller combo composer (buyer rail above consumes the catalog): pick 2+
 *  own live listings, name the combo, set the combo price. The server
 *  validates ownership/liveness and reprices at placement — this price is
 *  the offer, the Bundle row is the charge truth. Sellers only. */
function BundleComposer({ onPublished }: { onPublished: () => void }) {
  const { user } = useAuth();
  const { posts } = usePosts();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const me = (user?.username ?? '').trim().toLowerCase();
  if (!user || !(user as { isSeller?: boolean }).isSeller) return null;
  const mine = (posts as any[]).filter(
    (p) => String(p?.sellerUsername ?? '').toLowerCase() === me && p?.status !== 'hidden' && p?.isSold !== true
  );
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(0, 10)));
  const mrpSum = mine.filter((p) => picked.includes(String(p.id))).reduce((s, p) => s + Math.max(0, Math.round(Number(p?.price ?? 0))), 0);
  const comboPrice = Math.floor(Number(price));
  const canPublish =
    !busy && title.trim().length >= 3 && picked.length >= 2 && Number.isFinite(comboPrice) && comboPrice > 0 && comboPrice <= 10000000;
  const publish = async () => {
    if (!canPublish) return;
    setBusy(true);
    try {
      const res = await serverApi.createBundle({ title: title.trim().slice(0, 80), items: picked, price: comboPrice });
      if (!res.ok) {
        Alert.alert('Could not publish', String((res as { error?: unknown }).error ?? 'Check your connection and try again.'));
        return;
      }
      setTitle('');
      setPrice('');
      setPicked([]);
      setOpen(false);
      Alert.alert('Combo live', '"' + title.trim() + '" is now in Bundle Deals.');
      onPublished();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="rounded-[24px] p-4 mb-4" style={{ backgroundColor: colors.surfaceContainerLow }}>
      <TouchableOpacity onPress={() => setOpen((o) => !o)} accessibilityRole="button">
        <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 15, lineHeight: 22 }}>
          {open ? '− Close combo composer' : '+ Create a combo from my listings'}
        </Text>
        <Text className="font-inter-400 text-textSecondary mt-0.5" style={{ fontSize: 12, lineHeight: 16 }}>
          Sellers only · combos reprice from this row at checkout
        </Text>
      </TouchableOpacity>
      {open && (
        <View className="mt-3" style={{ gap: 10 }}>
          <TextInput
            className="px-4"
            style={{ height: 48, borderRadius: 12, backgroundColor: colors.surfaceContainerLowest, color: colors.textPrimary, fontSize: 14 }}
            placeholder="Combo title (e.g. Festive Kurti Set)"
            placeholderTextColor={colors.textTertiary}
            value={title}
            onChangeText={setTitle}
            maxLength={80}
          />
          <TextInput
            className="px-4"
            style={{ height: 48, borderRadius: 12, backgroundColor: colors.surfaceContainerLowest, color: colors.textPrimary, fontSize: 14 }}
            placeholder={mrpSum > 0 ? 'Combo price (items total ' + formatPrice(mrpSum) + ')' : 'Combo price'}
            placeholderTextColor={colors.textTertiary}
            value={price}
            onChangeText={setPrice}
            keyboardType="numeric"
          />
          {mine.length === 0 ? (
            <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 13, lineHeight: 18 }}>
              No live listings to bundle yet — publish a listing first.
            </Text>
          ) : (
            mine.slice(0, 30).map((p) => {
              const id = String(p.id);
              const on = picked.includes(id);
              return (
                <TouchableOpacity
                  key={id}
                  className="flex-row items-center px-3 py-2.5 rounded-figma-12"
                  style={{ backgroundColor: on ? colors.primaryContainer : colors.surfaceContainerLowest }}
                  onPress={() => toggle(id)}
                >
                  <Text className="flex-1 font-inter-500" numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: on ? colors.onPrimary : colors.textPrimary }}>
                    {String(p.title ?? p.description ?? 'Listing').split('\n')[0].slice(0, 60)}
                  </Text>
                  <Text className="font-inter-600 ml-2" style={{ fontSize: 13, lineHeight: 18, color: on ? colors.onPrimary : colors.textSecondary }}>
                    {formatPrice(Math.max(0, Math.round(Number(p?.price ?? 0))))}{on ? ' ✓' : ''}
                  </Text>
                </TouchableOpacity>
              );
            })
          )}
          <TouchableOpacity
            className="items-center justify-center"
            style={{ height: 48, borderRadius: 16, backgroundColor: canPublish ? colors.primaryContainer : colors.surfaceContainer, opacity: canPublish ? 1 : 0.6 }}
            disabled={!canPublish}
            onPress={publish}
          >
            <Text className="font-inter-600" style={{ fontSize: 15, lineHeight: 20, color: canPublish ? colors.onPrimary : colors.textTertiary }}>
              {busy ? 'Publishing…' : (picked.length >= 2 ? 'Publish combo (' + picked.length + ' items)' : 'Publish combo')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
