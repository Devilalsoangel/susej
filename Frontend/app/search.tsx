import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackIcon, BellIcon, BookmarkIcon, ChevronRightIcon, SearchIcon } from '../utils/icons';
import { colors, formatCount, formatPrice } from '../utils/theme';
import { useAuth, type User } from '../contexts/AuthContext';
import { useCommunities } from '../contexts/CommunityContext';
import { usePosts, type Post } from '../contexts/PostContext';
import { hasRealImage, resolveListingImage } from '../utils/productImages';
import { useBlockedSellers } from '../utils/blockedSellers';
import { serverApi, transportMessage, type SearchCategoryHit, type SearchHit, type SearchLocationHit, type SearchProductHit, type SearchResponse, type SearchUserHit } from '../utils/serverApi';

const RECENT_KEY_BASE = '@susej_recent_searches';
const SEARCHES_KEY_BASE = '@susej_saved_searches';
const SEARCH_KINDS = ['user', 'product', 'category', 'location'] as const;

type SearchTab = 'all' | 'products' | 'people' | 'categories' | 'locations' | 'communities' | 'hashtags';
type SearchKindFilter = (typeof SEARCH_KINDS)[number];

type SavedSearch = { id: string; query: string; savedAt: number; priceAlert: boolean };
type ProductResult = SearchProductHit | Post;
type UserResult = SearchUserHit;
type CategoryResult = SearchCategoryHit;
type LocationResult = SearchLocationHit;

const tabs: { key: SearchTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'products', label: 'Products' },
  { key: 'people', label: 'People' },
  { key: 'categories', label: 'Categories' },
  { key: 'locations', label: 'Locations' },
  { key: 'communities', label: 'Communities' },
  { key: 'hashtags', label: 'Hashtags' },
];

const norm = (value: unknown) => String(value ?? '').normalize('NFC').toLowerCase();
const queryLabel = (value: string) => value.trim().replace(/^@+/, '');

function initials(name: string, username: string) {
  const source = (name || username || 'S').replace(/^@/, '');
  const parts = source.split(/[\s_.-]+/).filter(Boolean);
  return ((parts[0]?.[0] || 'S') + (parts[1]?.[0] || '')).toUpperCase();
}

function ProductCard({ item, onPress }: { item: ProductResult; onPress: () => void }) {
  const imageSource = resolveListingImage(item, item.id);
  const title = item.title?.trim() || item.description?.split('\n')[0] || 'Untitled listing';
  return (
    <TouchableOpacity className="bg-surfaceContainerLowest rounded-figma-12 overflow-hidden mb-3" style={{ width: '48%', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 }} onPress={onPress}>
      <View className="w-full aspect-square bg-surfaceContainer items-center justify-center">
        {hasRealImage(item) ? <Image source={imageSource} className="absolute inset-0 w-full h-full" resizeMode="cover" /> : <Text className="font-inter-600 text-textSecondary" style={{ fontSize: 24 }}>{initials(title, item.sellerUsername)}</Text>}
      </View>
      <View className="p-3">
        <Text className="font-inter-500 text-textPrimary mb-1" style={{ fontSize: 13, lineHeight: 18 }} numberOfLines={2}>{title}</Text>
        <Text className="font-inter-700 text-primaryContainer" style={{ fontSize: 14, lineHeight: 20 }}>{formatPrice(item.price)}</Text>
        <Text className="font-inter-400 text-textSecondary mt-1" style={{ fontSize: 11, lineHeight: 15 }} numberOfLines={1}>{item.sellerName || `@${item.sellerUsername}`}</Text>
      </View>
    </TouchableOpacity>
  );
}

function UserRow({ item, onPress, isSelf }: { item: UserResult; onPress: () => void; isSelf?: boolean }) {
  return (
    <TouchableOpacity
      className="flex-row items-center gap-3 py-3 border-b border-surfaceContainer"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={isSelf ? `Your profile, ${item.displayName || item.name || item.username}` : `View ${item.displayName || item.name || item.username}`}
    >
      <View className="w-11 h-11 rounded-figma-full bg-surfaceContainer items-center justify-center overflow-hidden">
        {item.avatar ? <Image source={{ uri: item.avatar }} className="w-full h-full" resizeMode="cover" /> : <Text className="font-inter-600 text-primary" style={{ fontSize: 16 }}>{initials(item.displayName || item.name, item.username)}</Text>}
      </View>
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 14, lineHeight: 20 }}>{item.displayName || item.name || `@${item.username}`}</Text>
          {isSelf ? <Text className="font-inter-600 text-textTertiary" style={{ fontSize: 10 }}>(you)</Text> : null}
          {item.verified ? <Text className="font-inter-500 text-textTertiary" style={{ fontSize: 10 }}>Verified</Text> : null}
        </View>
        <Text className="font-inter-400 text-textSecondary mt-0.5" style={{ fontSize: 12, lineHeight: 18 }}>@{item.username}{item.location ? ` · ${item.location}` : ''}</Text>
      </View>
      <Text className="font-inter-500 text-primary" style={{ fontSize: 12 }}>{isSelf ? 'Profile' : 'View'}</Text>
    </TouchableOpacity>
  );
}

function CategoryRow({ item, onPress }: { item: CategoryResult; onPress: () => void }) {
  return (
    <TouchableOpacity className="flex-row items-center gap-3 py-3 border-b border-surfaceContainer" onPress={onPress}>
      <View className="w-11 h-11 rounded-figma-12 bg-surfaceContainer items-center justify-center">
        <Text className="font-inter-600 text-primary" style={{ fontSize: 16 }}>{item.name.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View className="flex-1">
        <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 14, lineHeight: 20 }}>{item.name}</Text>
        <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 12, lineHeight: 18 }}>{item.parentName || 'Marketplace category'}</Text>
      </View>
      <ChevronRightIcon size={16} color={colors.secondary} />
    </TouchableOpacity>
  );
}

function LocationRow({ item, onPress }: { item: LocationResult; onPress: () => void }) {
  return (
    <TouchableOpacity className="flex-row items-center gap-3 py-3 border-b border-surfaceContainer" onPress={onPress}>
      <View className="w-11 h-11 rounded-figma-full bg-surfaceContainer items-center justify-center">
        <Text className="font-inter-600 text-primary" style={{ fontSize: 18 }}>⌖</Text>
      </View>
      <View className="flex-1">
        <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 14, lineHeight: 20 }}>{item.label}</Text>
        <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 12, lineHeight: 18 }}>{formatCount(item.count)} marketplace matches</Text>
      </View>
      <ChevronRightIcon size={16} color={colors.secondary} />
    </TouchableOpacity>
  );
}

function ResultSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <View className="mb-5">
      <View className="flex-row items-center justify-between px-4 mb-1">
        <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 15, lineHeight: 22 }}>{title}</Text>
        {typeof count === 'number' && count > 0 ? <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 12 }}>{count}</Text> : null}
      </View>
      <View className="px-4">{children}</View>
    </View>
  );
}

export default function SearchScreen() {
  const params = useLocalSearchParams<{ q?: string; tab?: string }>();
  const initialQuery = typeof params.q === 'string' ? params.q : '';
  const initialTab = tabs.some((item) => item.key === params.tab) ? (params.tab as SearchTab) : 'all';
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(Boolean(initialQuery));
  const [tab, setTab] = useState<SearchTab>(initialTab);
  const [remote, setRemote] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const requestSeq = useRef(0);
  const exactUserCache = useRef(new Map<string, SearchUserHit | null>());
  const userRef = useRef<User | null>(null);
  const { user } = useAuth();
  userRef.current = user;
  const { posts, hiddenPostIds = [], mutedSellers = [] } = usePosts();
  const { communities } = useCommunities();
  const { blockedSet } = useBlockedSellers();
  const insets = useSafeAreaInsets();

  const recentKey = user?.username ? `${RECENT_KEY_BASE}:${user.username}` : RECENT_KEY_BASE;
  const searchesKey = user?.username ? `${SEARCHES_KEY_BASE}:${user.username}` : SEARCHES_KEY_BASE;
  const recentKeyNow = () => {
    const username = userRef.current?.username;
    return username ? `${RECENT_KEY_BASE}:${username}` : RECENT_KEY_BASE;
  };
  const term = query.trim();
  const normalizedTerm = norm(queryLabel(term));

  const addRecentSearch = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setRecentSearches((previous) => {
      const next = [value, ...previous.filter((item) => norm(item) !== norm(value))].slice(0, 8);
      AsyncStorage.setItem(recentKeyNow(), JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  useEffect(() => {
    if (typeof params.q === 'string' && params.q !== query) {
      setQuery(params.q);
      setSubmittedQuery(params.q);
      setSubmitted(true);
    }
    if (typeof params.tab === 'string' && tabs.some((item) => item.key === params.tab)) setTab(params.tab as SearchTab);
  }, [params.q, params.tab]);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(recentKey).then((raw) => {
      if (!active) return;
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        setRecentSearches(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8) : []);
      } catch {
        setRecentSearches([]);
      }
    }).catch(() => { if (active) setRecentSearches([]); });
    return () => { active = false; };
  }, [recentKey]);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(searchesKey).then((raw) => {
      if (!active) return;
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        setSavedSearches(Array.isArray(parsed) ? parsed : []);
      } catch {
        setSavedSearches([]);
      }
    }).catch(() => { if (active) setSavedSearches([]); });
    return () => { active = false; };
  }, [searchesKey]);

  useEffect(() => {
    const raw = term.trim();
    if (!raw) {
      setRemote(null);
      setLoading(false);
      setError('');
      return;
    }
    const id = ++requestSeq.current;
    const mode = submitted && raw === submittedQuery ? 'results' : raw.length === 1 ? 'suggest' : 'results';
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        const result = await serverApi.searchMarketplace({ q: raw, mode, types: [...SEARCH_KINDS], limit: mode === 'suggest' ? 8 : 20 });
      if (id !== requestSeq.current) return;
      let data = result.ok ? result.data : null;
      const handle = queryLabel(raw).toLowerCase();
      const canCheckExactUser = raw.length >= 3 && /^[@a-z0-9._-]+$/i.test(raw);
      if (canCheckExactUser && !data?.hits.some((hit) => hit.kind === 'user')) {
        let exact = exactUserCache.current.get(handle);
        if (exact === undefined) {
          const profile = await serverApi.getUserProfile(handle).catch(() => null);
          const rawUser = profile?.ok ? (profile.data?.user as Record<string, unknown> | undefined) : undefined;
          const username = String(rawUser?.username || handle).replace(/^@+/, '').trim();
          exact = rawUser && username ? {
            kind: 'user' as const,
            username,
            name: String(rawUser.name || rawUser.businessName || username),
            businessName: String(rawUser.businessName || ''),
            displayName: String(rawUser.businessName || rawUser.name || username),
            avatar: typeof rawUser.avatar === 'string' ? rawUser.avatar : null,
            location: String(rawUser.location || ''),
            category: String(rawUser.category || ''),
            isSeller: Boolean(rawUser.isSeller),
            verified: rawUser.verification === 'approved',
          } : null;
          exactUserCache.current.set(handle, exact);
        }
        if (exact) {
          data = data ?? { query: raw, mode, types: [...SEARCH_KINDS], limit: 8, hits: [], counts: { user: 0, product: 0, category: 0, location: 0, total: 0 }, degraded: true, unavailable: ['product', 'category', 'location'], hasMore: false };
          data = { ...data, hits: [exact, ...data.hits], counts: { ...data.counts, user: data.counts.user + 1, total: data.counts.total + 1 } };
        }
      }
        if (data) {
          setRemote(data);
          setError('');
        } else {
          setRemote(null);
          setError(transportMessage(result.error, 'try again'));
        }
      } catch {
        if (id === requestSeq.current) {
          setRemote(null);
          setError('Could not search right now. Check your connection and try again.');
        }
      } finally {
        if (id === requestSeq.current) setLoading(false);
      }
    }, mode === 'suggest' ? 120 : 280);
    return () => clearTimeout(timer);
  }, [submitted, submittedQuery, term]);

  const localProducts = useMemo(() => {
    if (!normalizedTerm) return [];
    return posts.filter((post) => {
      if (hiddenPostIds.includes(post.id) || mutedSellers.includes(post.sellerUsername) || blockedSet.has(norm(post.sellerUsername))) return false;
      return [post.title, post.description, post.category, post.brand, post.sellerName, post.sellerUsername, post.sellerLocation, post.listingLocation, ...(post.subCategories || []), ...(post.hashtags || [])].some((value) => norm(value).includes(normalizedTerm));
    }) as ProductResult[];
  }, [blockedSet, hiddenPostIds, mutedSellers, normalizedTerm, posts]);

  const remoteProducts = useMemo(() => (remote?.hits || []).filter((hit): hit is SearchProductHit => hit.kind === 'product'), [remote]);
  const productResults = remoteProducts.length ? remoteProducts : localProducts;
  const people = useMemo(() => (remote?.hits || []).filter((hit): hit is SearchUserHit => hit.kind === 'user'), [remote]);
  const categories = useMemo(() => (remote?.hits || []).filter((hit): hit is SearchCategoryHit => hit.kind === 'category'), [remote]);
  const locations = useMemo(() => (remote?.hits || []).filter((hit): hit is SearchLocationHit => hit.kind === 'location'), [remote]);
  const communityHits = useMemo(() => {
    if (!normalizedTerm) return [];
    return communities.filter((community) => [community.name, community.category, community.description].some((value) => norm(value).includes(normalizedTerm)));
  }, [communities, normalizedTerm]);
  const hashtagHits = useMemo(() => {
    if (!normalizedTerm) return [];
    const seen = new Set<string>();
    return posts.flatMap((post) => post.hashtags || []).filter((tag) => norm(tag).includes(normalizedTerm) && !seen.has(tag) && !!seen.add(tag));
  }, [normalizedTerm, posts]);

  const submitSearch = () => {
    const value = query.trim();
    if (!value) return;
    setSubmittedQuery(value);
    setSubmitted(true);
    addRecentSearch(value);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    setSubmitted(false);
    setError('');
  };

  const isCurrentSaved = Boolean(term && savedSearches.some((item) => norm(item.query) === normalizedTerm));
  const saveCurrentSearch = () => {
    if (!term || isCurrentSaved) return;
    const next = [{ id: `ss_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, query: term, savedAt: Date.now(), priceAlert: true }, ...savedSearches];
    setSavedSearches(next);
    AsyncStorage.setItem(searchesKey, JSON.stringify(next)).catch(() => {});
  };

  const myUsername = (user?.username ?? '').trim().toLowerCase();
  const isSelfHit = (username: string) => {
    const handle = username.trim().replace(/^@+/, '').toLowerCase();
    return Boolean(myUsername) && handle === myUsername;
  };

  const openHit = (hit: SearchHit) => {
    if (hit.kind === 'user') {
      // Instagram/Amazon standard: a hit that IS you opens YOUR profile tab, not
      // your public storefront - a shopper tapping "you" expects the account page.
      if (isSelfHit(hit.username)) router.push('/(tabs)/profile');
      else router.push(`/seller/${encodeURIComponent(hit.username)}`);
    } else if (hit.kind === 'product') router.push(`/product/${encodeURIComponent(hit.id)}`);
    else if (hit.kind === 'category') router.push(`/category/${encodeURIComponent(hit.slug)}`);
    else {
      setQuery(hit.label);
      setSubmittedQuery(hit.label);
      setSubmitted(true);
      setTab('products');
    }
  };

  const showEmpty = !loading && !error && (remote?.hits.length || productResults.length || communityHits.length || hashtagHits.length) === 0;
  const suggestionHits = submitted ? [] : (remote?.hits || []).slice(0, 8);

  const renderProducts = (items: ProductResult[]) => (
    <View className="flex-row flex-wrap" style={{ gap: 12 }}>
      {items.filter(hasRealImage).map((item) => <ProductCard key={item.id} item={item} onPress={() => router.push(`/product/${encodeURIComponent(item.id)}`)} />)}
    </View>
  );

  const renderTabContent = () => {
    if (loading && !remote) return <View className="items-center py-16"><ActivityIndicator color={colors.primary} /><Text className="font-inter-400 text-textSecondary mt-3" style={{ fontSize: 13 }}>Searching people, products, and places…</Text></View>;
    if (error && !remote) return <View className="px-6 py-16 items-center"><Text className="font-inter-500 text-textPrimary text-center" style={{ fontSize: 15, lineHeight: 22 }}>{error}</Text><TouchableOpacity className="mt-4 px-5 py-3 rounded-figma-12" style={{ backgroundColor: colors.primaryContainer }} onPress={submitSearch}><Text className="font-inter-600 text-white" style={{ fontSize: 13 }}>Try again</Text></TouchableOpacity></View>;
    if (tab === 'all') {
      if (suggestionHits.length) return <ResultSection title="Suggestions">{suggestionHits.map((hit) => <TouchableOpacity key={`${hit.kind}-${hit.kind === 'user' ? hit.username : hit.kind === 'product' || hit.kind === 'category' ? hit.id : hit.label}`} className="flex-row items-center gap-3 py-3 border-b border-surfaceContainer" onPress={() => openHit(hit)}><View className="w-9 h-9 rounded-figma-full bg-surfaceContainer items-center justify-center"><Text className="font-inter-600 text-primary" style={{ fontSize: 14 }}>{hit.kind === 'user' ? '@' : hit.kind === 'product' ? '⌕' : hit.kind === 'category' ? '≡' : '⌖'}</Text></View><Text className="flex-1 font-inter-500 text-textPrimary" style={{ fontSize: 14 }} numberOfLines={1}>{hit.kind === 'user' ? `${hit.displayName || hit.name} · @${hit.username}` : hit.kind === 'product' ? hit.title : hit.kind === 'category' ? hit.name : hit.label}</Text><ChevronRightIcon size={15} color={colors.secondary} /></TouchableOpacity>)}</ResultSection>;
      return <View>{people.length ? <ResultSection title="People" count={people.length}>{people.map((hit) => <UserRow key={hit.username} item={hit} onPress={() => openHit(hit)} isSelf={isSelfHit(hit.username)} />)}</ResultSection> : null}{productResults.length ? <ResultSection title="Products" count={productResults.length}>{renderProducts(productResults)}</ResultSection> : null}{categories.length ? <ResultSection title="Categories" count={categories.length}>{categories.map((hit) => <CategoryRow key={hit.id} item={hit} onPress={() => openHit(hit)} />)}</ResultSection> : null}{locations.length ? <ResultSection title="Locations" count={locations.length}>{locations.map((hit) => <LocationRow key={hit.label} item={hit} onPress={() => openHit(hit)} />)}</ResultSection> : null}{showEmpty ? <View className="items-center py-16 px-6"><Text className="font-inter-500 text-textSecondary text-center" style={{ fontSize: 15 }}>No people, products, or places match “{term}”.</Text><Text className="font-inter-400 text-textTertiary text-center mt-2" style={{ fontSize: 12 }}>Try a username, product name, category, or city.</Text></View> : null}</View>;
    }
    if (tab === 'products') return productResults.length ? renderProducts(productResults) : <Text className="text-center text-textSecondary py-16" style={{ fontSize: 14 }}>No products match “{term}”.</Text>;
    if (tab === 'people') return people.length ? people.map((hit) => <UserRow key={hit.username} item={hit} onPress={() => openHit(hit)} />) : <Text className="text-center text-textSecondary py-16" style={{ fontSize: 14 }}>No people match “{term}”.</Text>;
    if (tab === 'categories') return categories.length ? categories.map((hit) => <CategoryRow key={hit.id} item={hit} onPress={() => openHit(hit)} />) : <Text className="text-center text-textSecondary py-16" style={{ fontSize: 14 }}>No categories match “{term}”.</Text>;
    if (tab === 'locations') return locations.length ? locations.map((hit) => <LocationRow key={hit.label} item={hit} onPress={() => openHit(hit)} />) : <Text className="text-center text-text-secondary py-16" style={{ fontSize: 14 }}>No public locations match “{term}”.</Text>;
    if (tab === 'communities') return communityHits.length ? communityHits.map((community) => <TouchableOpacity key={community.id} className="flex-row items-center gap-3 py-3 border-b border-surfaceContainer" onPress={() => router.push(`/community/${community.id}`)}><View className="w-11 h-11 rounded-figma-12 bg-primaryContainer items-center justify-center"><Text className="font-inter-600 text-white" style={{ fontSize: 16 }}>{community.name.slice(0, 1)}</Text></View><View className="flex-1"><Text className="font-inter-600 text-textPrimary" style={{ fontSize: 14 }}>{community.name}</Text><Text className="font-inter-400 text-textSecondary" style={{ fontSize: 12 }}>{community.category} · {formatCount(community.memberCount)} members</Text></View><ChevronRightIcon size={16} color={colors.secondary} /></TouchableOpacity>) : <Text className="text-center text-textSecondary py-16" style={{ fontSize: 14 }}>No communities match “{term}”.</Text>;
    return hashtagHits.length ? hashtagHits.map((tag) => <TouchableOpacity key={tag} className="flex-row items-center gap-3 py-3 border-b border-surfaceContainer" onPress={() => router.push(`/hashtag/${encodeURIComponent(tag.replace(/^#/, ''))}`)}><View className="w-11 h-11 rounded-figma-full bg-surfaceContainer items-center justify-center"><Text className="font-inter-700 text-primary" style={{ fontSize: 16 }}>#</Text></View><Text className="flex-1 font-inter-500 text-textPrimary" style={{ fontSize: 14 }}>{tag}</Text><ChevronRightIcon size={16} color={colors.secondary} /></TouchableOpacity>) : <Text className="text-center text-textSecondary py-16" style={{ fontSize: 14 }}>No hashtags match “{term}”.</Text>;
  };

  return (
    <View className="flex-1 bg-surface">
      <View className="flex-row items-center gap-3 px-4" style={{ height: 56 + insets.top, paddingTop: insets.top }}>
        <TouchableOpacity onPress={() => router.back()}><BackIcon size={20} color={colors.primaryContainer} /></TouchableOpacity>
        <View className="flex-1 flex-row items-center h-11 px-4 bg-surfaceContainerLow rounded-figma-16">
          <SearchIcon size={16} color={colors.secondary} />
          <TextInput className="flex-1 ml-3 text-textPrimary" style={{ fontSize: 14 }} placeholder="Search people, products, places..." placeholderTextColor={colors.secondary} value={query} onChangeText={changeQuery} onSubmitEditing={submitSearch} returnKeyType="search" autoFocus />
          {term ? <TouchableOpacity onPress={() => changeQuery('')}><Text className="font-inter-500 text-textSecondary" style={{ fontSize: 18 }}>×</Text></TouchableOpacity> : null}
        </View>
        <TouchableOpacity className="w-11 h-11 items-center justify-center rounded-figma-full" style={{ backgroundColor: isCurrentSaved ? colors.primaryFixed : colors.surfaceContainerLow }} disabled={!term || isCurrentSaved} onPress={saveCurrentSearch}><BookmarkIcon size={18} color={isCurrentSaved ? colors.primary : colors.textSecondary} /></TouchableOpacity>
        <TouchableOpacity className="w-11 h-11 items-center justify-center rounded-figma-full" style={{ backgroundColor: colors.surfaceContainerLow }} onPress={() => router.push('/saved-searches')}><BellIcon size={18} color={colors.textSecondary} /></TouchableOpacity>
      </View>
      {!term ? (
        <ScrollView contentContainerStyle={{ paddingTop: 14, paddingBottom: insets.bottom + 32 }}>
          <View className="px-4 mb-3 flex-row items-center justify-between"><Text className="font-inter-600 text-textPrimary" style={{ fontSize: 16 }}>Recent searches</Text>{recentSearches.length ? <TouchableOpacity onPress={() => { setRecentSearches([]); AsyncStorage.setItem(recentKeyNow(), '[]').catch(() => {}); }}><Text className="font-inter-500 text-primary" style={{ fontSize: 12 }}>Clear</Text></TouchableOpacity> : null}</View>
          {recentSearches.length ? recentSearches.map((item) => <TouchableOpacity key={item} className="flex-row items-center gap-3 px-4 py-3 border-b border-surfaceContainer" onPress={() => { changeQuery(item); }}><SearchIcon size={14} color={colors.secondary} /><Text className="font-inter-400 text-textSecondary" style={{ fontSize: 14 }}>{item}</Text></TouchableOpacity>) : <Text className="px-4 py-3 font-inter-400 text-textSecondary" style={{ fontSize: 14 }}>Search usernames, products, categories, or places.</Text>}
          <TouchableOpacity className="flex-row items-center justify-between px-4 py-4 mt-3" onPress={() => router.push('/saved-searches')}><View className="flex-row items-center gap-3"><BellIcon size={15} color={colors.secondary} /><Text className="font-inter-500 text-textPrimary" style={{ fontSize: 14 }}>Saved searches & price alerts</Text></View><ChevronRightIcon size={16} color={colors.secondary} /></TouchableOpacity>
        </ScrollView>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
            {tabs.map((item) => <TouchableOpacity key={item.key} className="px-4 py-2 rounded-figma-full" style={{ backgroundColor: tab === item.key ? colors.primaryContainer : colors.surfaceContainerLow }} onPress={() => setTab(item.key)}><Text className="font-inter-600" style={{ fontSize: 13, lineHeight: 18, color: tab === item.key ? colors.onPrimary : colors.textSecondary }}>{item.label}{remote?.counts && item.key !== 'all' && item.key !== 'communities' && item.key !== 'hashtags' ? ` ${remote.counts[item.key === 'people' ? 'user' : item.key === 'categories' ? 'category' : item.key === 'locations' ? 'location' : 'product']}` : ''}</Text></TouchableOpacity>)}
          </ScrollView>
          {loading && remote ? <View className="px-4 pb-2"><Text className="font-inter-400 text-textSecondary" style={{ fontSize: 11 }}>Updating results…</Text></View> : null}
          {error && remote ? <View className="px-4 pb-2"><Text className="font-inter-400 text-textSecondary" style={{ fontSize: 11 }}>{error} Showing saved local listings where available.</Text></View> : null}
          {remote?.degraded ? <View className="px-4 pb-2"><Text className="font-inter-400 text-textTertiary" style={{ fontSize: 11 }}>Some search sources are temporarily unavailable.</Text></View> : null}
          {renderTabContent()}
        </ScrollView>
      )}
    </View>
  );
}
