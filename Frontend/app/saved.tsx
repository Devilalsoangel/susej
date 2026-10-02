import { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BookmarkIcon, ChevronLeftIcon } from '../utils/icons';
import { colors, formatPrice } from '../utils/theme';
import { useBookmark, type BookmarkedProduct } from '../contexts/BookmarkContext';
import { usePosts } from '../contexts/PostContext';
import { useAuth } from '../contexts/AuthContext';
import { resolveListingImage } from '../utils/productImages';

const BOOKMARKS_KEY_BASE = '@susej_bookmarked_products';

// NOTE: an Instagram-style Collections system used to live here (tab +
// create/rename/delete modals + detail view), but nothing could ever enter a
// collection — no add-to-collection action exists on any surface — so every
// branch was unreachable dead code. Removed outright; collections return with
// the add action, not before.
export default function SavedScreen() {
  const { bookmarksList, bookmarkCount } = useBookmark();
  const { posts } = usePosts();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [bookmarkLoaded, setBookmarkLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const username = user?.username;
    if (!username) {
      setBookmarkLoaded(true);
      return;
    }
    setBookmarkLoaded(false);
    void AsyncStorage.getItem(`${BOOKMARKS_KEY_BASE}:${username}`)
      .then(() => { if (alive) setBookmarkLoaded(true); })
      .catch(() => { if (alive) setBookmarkLoaded(true); });
    return () => { alive = false; };
  }, [user?.username]);

  useEffect(() => {
    const username = user?.username;
    if (!username || bookmarksList.length === 0) return;
    const key = `${BOOKMARKS_KEY_BASE}:${username}`;
    let changed = false;
    const next = bookmarksList.map((item) => {
      if (item.imageUrl) return item;
      const post = posts.find((candidate) => candidate.id === item.productId);
      const imageUrl = post?.image || post?.images?.[0];
      if (!imageUrl) return item;
      changed = true;
      return { ...item, imageUrl };
    });
    if (changed) void AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
  }, [bookmarksList, posts, user?.username]);

  const renderBookmarkTile = (p: BookmarkedProduct) => {
    const livePost = posts.find((post) => post.id === p.productId);
    const imageUrl = p.imageUrl || livePost?.image || livePost?.images?.[0];
    return (
    <View className="flex-1">
      <TouchableOpacity
        className="overflow-hidden"
        style={{ aspectRatio: 1, backgroundColor: colors.surfaceContainer, borderRadius: 8 }}
        onPress={() => router.push(`/product/${p.productId}`)}
      >
        <Image
          source={resolveListingImage({ image: imageUrl }, p.productId)}
          className="w-full h-full"
          resizeMode="cover"
        />
        <View className="absolute left-1.5 bottom-1.5 px-2 py-1 rounded-full" style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}>
          <Text className="font-inter-700" style={{ fontSize: 11, lineHeight: 14, color: '#FFFFFF' }}>
            {formatPrice(p.price)}
          </Text>
        </View>
      </TouchableOpacity>
      <Text className="font-inter-400 text-textSecondary mt-1" numberOfLines={1} style={{ fontSize: 11, lineHeight: 14 }}>
        {(p.description || '').split('\n')[0] || p.sellerName}
      </Text>
    </View>
  );
  };

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      {/* Header - back chevron + Saved title */}
      <View className="flex-row items-center justify-between px-5" style={{ height: 52 + insets.top, paddingTop: insets.top }}>
        <TouchableOpacity onPress={() => router.back()}>
          <ChevronLeftIcon size={18} color={colors.primary} />
        </TouchableOpacity>
        <Text className="font-inter-700" style={{ fontSize: 20, lineHeight: 28, color: colors.textPrimary }}>
          Saved
        </Text>
        <View className="px-4 py-2" />
      </View>

      {/* Title Section */}
      <View className="px-5 mb-4">
        <Text className="font-inter-700 text-textPrimary mb-1" style={{ fontSize: 32, lineHeight: 40, letterSpacing: -0.8 }}>
          Saved Items
        </Text>
        <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 16, lineHeight: 24 }}>
          Organize your inspirations and{'\n'}wishlist
        </Text>
      </View>

      {/* Content */}
      {!bookmarkLoaded ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.primaryContainer} />
        </View>
      ) : bookmarkCount === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <View className="w-24 h-24 rounded-full bg-surfaceContainerLow items-center justify-center mb-6">
            <BookmarkIcon size={36} color={colors.primaryContainer} />
          </View>
          <Text className="font-inter-700 text-textPrimary mb-2 text-center" style={{ fontSize: 18, lineHeight: 24 }}>
            No saved items yet
          </Text>
          <Text className="font-inter-400 text-textSecondary text-center" style={{ fontSize: 14, lineHeight: 20 }}>
            Tap the bookmark icon on any product to save it here
          </Text>
        </View>
      ) : (
        <FlatList
          data={bookmarksList}
          keyExtractor={(item) => item.productId}
          numColumns={3}
          columnWrapperStyle={{ gap: 4 }}
          contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: 100 + insets.bottom }}
          renderItem={({ item }) => renderBookmarkTile(item)}
        />
      )}
    </View>
  );
}
