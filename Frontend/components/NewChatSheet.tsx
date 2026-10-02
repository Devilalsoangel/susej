import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { colors } from '../utils/theme';
import { SearchIcon, CloseIcon } from '../utils/icons';
import { serverApi, type SearchUserHit } from '../utils/serverApi';
import { UserAvatar } from './UserAvatar';

/**
 * Start a conversation with someone, by name.
 *
 * WHY: an inbox that cannot load its thread list used to be a DEAD END - one
 * error line and a "Try again" button, with no way to message anybody, even
 * though the write path (create thread + send) was working fine. A chat app
 * that cannot start a chat is broken, so this is reachable from the error state
 * and from the empty state, and it depends only on endpoints that work.
 *
 * People only: the server also matches products and places, and offering a
 * stranger because their category contains the typed letter is not a person
 * search. Ranking is the search-box norm - exact, then starts-with, then
 * contains - and nothing matching shows an honest empty line.
 */
export function NewChatSheet({
  visible,
  selfUsername,
  onClose,
  onPick,
}: {
  visible: boolean;
  selfUsername?: string;
  onClose: () => void;
  onPick: (hit: SearchUserHit) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchUserHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (visible) {
      setQuery('');
      setHits([]);
      setSearched(false);
      setFailed(false);
      setLoading(false);
    }
  }, [visible]);

  const needle = query.trim();
  const lastRequest = useRef(0);
  useEffect(() => {
    if (!needle) {
      setHits([]);
      setSearched(false);
      setFailed(false);
      return;
    }
    const id = ++lastRequest.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await serverApi.searchMarketplace({
          q: needle,
          mode: needle.length === 1 ? 'suggest' : 'results',
          types: ['user'],
          limit: needle.length === 1 ? 8 : 10,
        });
        if (id !== lastRequest.current) return;
        const data = res.ok && res.data ? res.data : null;
        const people = ((data ? data.hits : []) as SearchUserHit[]).filter((hit) => {
          if (hit.kind !== 'user') return false;
          if (selfUsername && hit.username.toLowerCase() === selfUsername.toLowerCase()) return false;
          const low = needle.toLowerCase();
          return [hit.username, hit.name, hit.displayName, hit.businessName]
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
            .some((v) => v.toLowerCase().includes(low));
        });
        const rank = (hit: SearchUserHit) => {
          const low = needle.toLowerCase();
          const fields = [hit.username, hit.name, hit.displayName, hit.businessName]
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
            .map((v) => v.toLowerCase());
          if (fields.some((v) => v === low)) return 0;
          if (fields.some((v) => v.startsWith(low))) return 1;
          return 2;
        };
        setHits([...people].sort((a, b) => rank(a) - rank(b)));
        setSearched(true);
        setFailed(false);
      } catch {
        setFailed(true);
        setSearched(true);
      } finally {
        if (id === lastRequest.current) setLoading(false);
      }
    }, 280);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, selfUsername]);

  if (!visible) return null;

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.surfaceContainerLowest, zIndex: 40, elevation: 20 }}>
      <View className="flex-row items-center px-4" style={{ paddingTop: insets.top + 8, paddingBottom: 10 }}>
        <Text className="font-inter-700 text-textPrimary" style={{ fontSize: 18, lineHeight: 24 }}>
          New message
        </Text>
        <TouchableOpacity onPress={onClose} className="ml-auto p-1">
          <CloseIcon size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <View className="mx-4 mb-3 flex-row items-center px-4" style={{ height: 46, backgroundColor: colors.surfaceContainerLow, borderRadius: 12 }}>
        <SearchIcon size={16} color={colors.secondary} style={{ opacity: 0.4 }} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Search people by name or @handle"
          placeholderTextColor={colors.textSecondary}
          style={{ flex: 1, marginLeft: 10, fontSize: 15, color: colors.textPrimary }}
        />
        {loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>

      {!needle ? (
        <View className="px-8 py-10 items-center">
          <Text className="font-inter-400 text-textSecondary text-center" style={{ fontSize: 14, lineHeight: 20 }}>
            Type a name or handle to start a conversation. Tap Message on any product to
            negotiate with a seller too.
          </Text>
        </View>
      ) : failed ? (
        <View className="px-8 py-10 items-center">
          <Text className="font-inter-400 text-textSecondary text-center" style={{ fontSize: 14, lineHeight: 20 }}>
            Couldn&apos;t search people right now. Check your connection and try again.
          </Text>
        </View>
      ) : searched && hits.length === 0 ? (
        <View className="px-8 py-10 items-center">
          <Text className="font-inter-400 text-textSecondary text-center" style={{ fontSize: 14, lineHeight: 20 }}>
            No people found for &quot;{needle}&quot;. Check the spelling, or try their @handle.
          </Text>
        </View>
      ) : (
        <FlatList
          data={hits}
          keyExtractor={(item) => item.username}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              className="flex-row items-center py-3"
              onPress={() => onPick(item)}
            >
              <UserAvatar name={item.businessName || item.name || item.username} username={item.username} uri={item.avatar} size={44} />
              <View className="flex-1 ml-3">
                <Text className="font-inter-600 text-textPrimary" numberOfLines={1} style={{ fontSize: 15, lineHeight: 20 }}>
                  {item.businessName || item.displayName || item.name || item.username}
                </Text>
                <Text className="font-inter-400 text-textSecondary" numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>
                  @{item.username}
                  {item.isSeller && item.category ? ` · ${item.category} seller` : ''}
                </Text>
              </View>
              {item.verified ? <Svg width={16} height={16} viewBox="0 0 24 24" fill="none"><Path d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.9 1 2.9-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9L3.2 15.8l1-2.9-1-2.9L5.7 8.3l.9-2.9 3 .2L12 2z" fill={colors.primary} /></Svg> : null}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}
