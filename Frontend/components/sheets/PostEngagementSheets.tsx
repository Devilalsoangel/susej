import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  Keyboard,
  Dimensions,
  Image,
  Platform,
  Share as RNShare,
  PanResponder,
} from 'react-native';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { SendIcon, HeartIcon, CloseIcon } from '../../utils/icons';
import { colors } from '../../utils/theme';
import { UserAvatar } from '../UserAvatar';
import { useAuth } from '../../contexts/AuthContext';
import { serverApi } from '../../utils/serverApi';

// ─── Shared Instagram-style bottom sheet ────────────────────────────────────
// Slides up from the bottom, drag handle at top (drag down or tap backdrop or
// press hardware back to dismiss), content scrolls above a fixed input row.

interface SheetShellProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  heightRatio?: number; // fraction of screen height (0-1)
  children: React.ReactNode;
}

// Android: Keyboard events never fire while a transparent Modal has focus
// (long-standing RN bug), so the sheet cannot listen for the keyboard.
// Instead, inputs inside the sheet report focus/blur (those always fire)
// and BottomSheet reserves an estimated keyboard height on focus.
const SheetInputFocusCtx = createContext<{ setInputFocused: (v: boolean) => void }>({
  setInputFocused: () => {},
});
export function useSheetInputFocus() {
  return useContext(SheetInputFocusCtx);
}

export function BottomSheet({ visible, onClose, title, heightRatio = 0.72, children }: SheetShellProps) {
  const handleClose = () => {
    Keyboard.dismiss();
    onClose();
  };
  // Drag-to-close on the handle area
  const pan = useRef({ y: 0 });
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 6,
      onPanResponderMove: (_e, g) => {
        pan.current.y = Math.max(0, g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 80) handleClose();
        pan.current.y = 0;
      },
    })
  ).current;

  // Keyboard tracking — KeyboardAvoidingView inside a transparent Android Modal
  // is unreliable (composer ended up under the keyboard). Track events directly
  // and shrink the sheet so it always sits above the keyboard.
  const [kbHeight, setKbHeight] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const screenHeight = Dimensions.get('window').height;
  useEffect(() => {
    if (!visible) return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) =>
      setKbHeight(e.endCoordinates.height)
    );
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setKbHeight(0)
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, [visible]);

  // Android fallback: no keyboard events inside Modal — reserve an estimated
  // keyboard height while an input is focused. iOS uses the real events above.
  useEffect(() => {
    if (Platform.OS === 'ios' || !visible) return;
    setKbHeight(inputFocused ? Math.round(Dimensions.get('window').height * 0.38) : 0);
  }, [inputFocused, visible]);

  // Sheet height: normal ratio, but never taller than the space above the
  // keyboard (+ headroom for the handle/title). marginBottom LIFTS the sheet
  // above the keyboard — shrinking alone keeps it glued to the screen bottom
  // (still under the keyboard), lifting is what makes it visible.
  const maxSheetHeight = Math.max(screenHeight * heightRatio - kbHeight, 200);

  if (!visible) return null;
  return (
    <SheetInputFocusCtx.Provider value={{ setInputFocused }}>
      <Modal transparent animationType="slide" visible={visible} onRequestClose={handleClose} statusBarTranslucent>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay }}>
          <TouchableOpacity activeOpacity={1} onPress={handleClose} style={{ flex: 1 }} />
          <View style={{ height: maxSheetHeight, marginBottom: kbHeight }}>
            <View className="bg-surfaceContainerLowest rounded-t-figma-24 overflow-hidden flex-1">
              {/* Handle + title */}
              <View {...panResponder.panHandlers} className="items-center pt-2.5 pb-1">
                <View style={{ width: 40, height: 4.5, borderRadius: 3, backgroundColor: colors.outlineVariant }} />
                {title ? (
                  <Text className="font-inter-700 text-textPrimary mt-2.5" style={{ fontSize: 15, lineHeight: 20 }}>
                    {title}
                  </Text>
                ) : null}
              </View>
              {children}
            </View>
          </View>
        </View>
      </Modal>
    </SheetInputFocusCtx.Provider>
  );
}

const initialsAvatar = (name: string) => (name || '?').trim().charAt(0).toUpperCase();

const timeAgo = (t: number) => {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

// ─── Comments sheet ─────────────────────────────────────────────────────────
// SINGLE implementation used by feed cards AND the product page so the two
// surfaces can never drift apart again (count-vs-list invariant bug class).
// Behavior mirrors Instagram: avatar images, tappable author -> public
// profile, per-comment like hearts, one-level replies, live count in title.

interface CommentRow {
  id: string;
  author: string;
  username?: string | null;
  parentId?: string | null;
  text: string;
  likes?: number;
  likedByMe?: boolean;
  time: number;
}

function CommentAvatar({ author, username, size = 32 }: { author: string; username?: string | null; size?: number }) {
  // resolveAvatar() always returned a source, so the initials branch below was
  // unreachable and every commenter rendered the shared blank circle - the
  // fallback existed but could never fire. <UserAvatar> resolves the account's
  // real picture by handle and falls back to initials itself.
  return <UserAvatar name={author || username || 'susej'} username={username} size={size} />;
}

export function CommentsSheet({
  visible,
  postId,
  onClose,
  onCountChange,
  fallbackComments,
}: {
  visible: boolean;
  postId: string;
  onClose: () => void;
  onCountChange?: (delta: number) => void;
  // Offline/local posts (post_ ids have no server thread): render these and
  // append locally instead of pretending a server roundtrip happened.
  fallbackComments?: Array<{ author: string; text: string; time: number }>;
}) {
  const { user } = useAuth();
  const { setInputFocused } = useSheetInputFocus();
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<CommentRow | null>(null);
  // Seller dual-persona: comment as the personal profile OR as the store.
  const [asStore, setAsStore] = useState(false);
  const canStorePersona = !!(user?.isSeller && user?.businessName);

  const isLocalPost = !postId || postId.startsWith('post_');

  useEffect(() => {
    if (!visible || !postId) return;
    let alive = true;
    setLoadError(false);
    setLoaded(false);
    if (isLocalPost) {
      setComments(
        (fallbackComments ?? []).map((c, i) => ({
          id: `local_${i}_${c.time}`,
          author: c.author,
          username: null,
          parentId: null,
          text: c.text,
          likes: 0,
          likedByMe: false,
          time: c.time,
        }))
      );
      setLoaded(true);
      return;
    }
    setComments([]);
    setLoading(true);
    serverApi.getComments(postId).then((res) => {
      if (!alive) return;
      if (!res.ok || !res.data || !Array.isArray(res.data.comments)) {
        setLoadError(true);
      } else {
        setComments(res.data.comments);
      }
      setLoaded(true);
      setLoading(false);
    }).catch(() => {
      if (!alive) return;
      setLoadError(true);
      setLoaded(true);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, postId, reloadKey]);

  const submit = useCallback(async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    const parentId = replyTo && !replyTo.id.startsWith('local_') ? replyTo.id : undefined;
    const displayAuthor = canStorePersona && asStore ? user!.businessName! : user?.name || 'You';
    const optimistic: CommentRow = {
      id: `local_${Date.now()}`,
      author: displayAuthor,
      username: user?.username ?? null,
      parentId: replyTo?.parentId ?? replyTo?.id ?? null,
      text: t,
      likes: 0,
      likedByMe: false,
      time: Date.now(),
    };
    setComments((prev) => [...prev, optimistic]);
    setText('');
    const clearedReplyTo = replyTo;
    setReplyTo(null);
    const rollback = () => {
      setComments((prev) => prev.filter((c) => c.id !== optimistic.id));
      setText(t);
      setReplyTo(clearedReplyTo);
    };
    try {
      if (isLocalPost) {
        onCountChange?.(1);
        return;
      }
      const res = await serverApi.addComment(
        postId,
        t,
        parentId,
        canStorePersona && asStore ? user!.businessName! : undefined
      );
      const serverComment = res.ok ? res.data?.comment : null;
      if (!serverComment) {
        rollback();
        return;
      }
      setComments((prev) =>
        prev.map((c) =>
          c.id === optimistic.id
            ? {
                ...c,
                id: String(serverComment.id),
                author: String(serverComment.author ?? c.author),
                username: serverComment.username ?? c.username,
                parentId: serverComment.parentId ?? c.parentId,
                text: String(serverComment.text ?? c.text),
                time: Number(serverComment.time ?? c.time),
              }
            : c
        )
      );
      onCountChange?.(1);
    } catch {
      rollback();
    } finally {
      setSending(false);
    }
  }, [text, sending, postId, onCountChange, replyTo, isLocalPost, user, asStore, canStorePersona]);

  const toggleLike = useCallback(
    async (row: CommentRow) => {
      if (row.id.startsWith('local_') || isLocalPost) return;
      const previous = row;
      const nextLiked = !row.likedByMe;
      const nextLikes = Math.max(0, (row.likes ?? 0) + (nextLiked ? 1 : -1));
      setComments((prev) =>
        prev.map((c) => (c.id === row.id ? { ...c, likedByMe: nextLiked, likes: nextLikes } : c))
      );
      const res = await serverApi.likeComment(postId, row.id).catch(() => null);
      if (res?.ok && res.data) {
        setComments((prev) =>
          prev.map((c) => (c.id === row.id ? { ...c, likes: res.data!.likes, likedByMe: res.data!.likedByMe } : c))
        );
      } else {
        setComments((prev) => prev.map((c) => (c.id === row.id ? previous : c)));
      }
    },
    [postId, isLocalPost]
  );

  const openProfile = useCallback(
    (row: CommentRow) => {
      if (!row.username || row.username.startsWith('local_')) return;
      // Push WITHOUT closing: the sheet stays mounted underneath, so Back
      // returns to the same thread with any drafted text intact (IG pattern).
      // Closing here stole the composer mid-type.
      router.push(`/seller/${row.username}`);
    },
    []
  );

  // Group: top-level threads with their replies nested directly underneath.
  const topLevel = comments.filter((c) => !c.parentId);
  const repliesOf = (id: string) => comments.filter((c) => c.parentId === id);

  const title = loaded && comments.length > 0 ? `Comments · ${comments.length}` : 'Comments';

  const renderRow = (item: CommentRow, isReply: boolean) => (
    <View key={item.id} className="flex-row mb-3.5" style={[{ gap: 10 }, isReply ? { paddingLeft: 40 } : null]}>
      <TouchableOpacity
        activeOpacity={item.username ? 0.7 : 1}
        onPress={() => openProfile(item)}
        disabled={!item.username}
      >
        <CommentAvatar author={item.author} username={item.username} size={isReply ? 26 : 32} />
      </TouchableOpacity>
      <View className="flex-1">
        <TouchableOpacity activeOpacity={item.username ? 0.7 : 1} onPress={() => openProfile(item)} disabled={!item.username}>
          <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 13, lineHeight: 17 }}>
            {item.author}
            <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 12, lineHeight: 16 }}>
              {'  '}
              {timeAgo(item.time)}
            </Text>
          </Text>
        </TouchableOpacity>
        <Text className="font-inter-400 text-textPrimary mt-0.5" style={{ fontSize: 14, lineHeight: 19 }}>
          {item.text}
        </Text>
        <View className="flex-row items-center mt-1" style={{ gap: 16 }}>
          {!isReply ? (
            <TouchableOpacity onPress={() => { setReplyTo(item); }}>
              <Text className="font-inter-600 text-textSecondary" style={{ fontSize: 12, lineHeight: 15 }}>
                Reply
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
      {/* Per-comment like heart (IG pattern) */}
      <TouchableOpacity
        className="items-center pt-1"
        style={{ width: 34 }}
        onPress={() => toggleLike(item)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <HeartIcon size={14} color={item.likedByMe ? colors.error : colors.textSecondary} />
        {item.likes && item.likes > 0 ? (
          <Text className="font-inter-500 text-textSecondary mt-0.5" style={{ fontSize: 11, lineHeight: 13 }}>
            {item.likes}
          </Text>
        ) : null}
      </TouchableOpacity>
    </View>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <View style={{ flex: 1 }}>
        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.primaryContainer} />
          </View>
        ) : loadError ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 15, lineHeight: 20 }}>
              Comments couldn&apos;t load
            </Text>
            <Text className="font-inter-400 text-textSecondary text-center mt-1" style={{ fontSize: 13, lineHeight: 18 }}>
              The listing may be available, but the conversation could not be reached.
            </Text>
            <TouchableOpacity className="mt-4 px-5 py-2 rounded-full" style={{ backgroundColor: colors.primaryContainer }} onPress={() => setReloadKey((value) => value + 1)}>
              <Text className="font-inter-600 text-white" style={{ fontSize: 13, lineHeight: 18 }}>
                Try again
              </Text>
            </TouchableOpacity>
          </View>
        ) : comments.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
            <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 15, lineHeight: 20 }}>
              No comments yet
            </Text>
            <Text className="font-inter-400 text-textSecondary text-center mt-1" style={{ fontSize: 13, lineHeight: 18 }}>
              Start the conversation.
            </Text>
          </View>
        ) : (
          <FlatList
            data={topLevel}
            keyExtractor={(c) => c.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}
            renderItem={({ item }) => (
              <View>
                {renderRow(item, false)}
                {repliesOf(item.id).map((r) => renderRow(r, true))}
              </View>
            )}
          />
        )}

        {/* Reply context chip (IG pattern) */}
        {replyTo ? (
          <View className="flex-row items-center mx-4 mt-2 px-3 py-2 rounded-figma-8" style={{ backgroundColor: colors.surfaceContainerLow }}>
            <Text className="flex-1 font-inter-400 text-textSecondary" style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={1}>
              Replying to {replyTo.author}
            </Text>
            <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <CloseIcon size={14} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Seller persona switch - minimal one-tap identity toggle */}
        {canStorePersona && (
          <View className="flex-row items-center mx-4 mt-2">
            <TouchableOpacity
              onPress={() => setAsStore((v) => !v)}
              className="flex-row items-center px-2.5 py-1.5 rounded-full"
              style={{ backgroundColor: asStore ? colors.primaryContainer : colors.surfaceContainerLow }}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" style={{ marginRight: 5 }}>
                <Path
                  d="M16 3l4 4-4 4M20 7H8M8 21l-4-4 4-4M4 17h12"
                  stroke={asStore ? colors.onPrimary : colors.textSecondary}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
              <Text
                className="font-inter-600"
                style={{ fontSize: 11, lineHeight: 14, color: asStore ? colors.onPrimary : colors.textSecondary }}
                numberOfLines={1}
              >
                {asStore ? `As ${user!.businessName}` : `As @${user?.username ?? 'me'}`}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Composer pinned to the bottom of the sheet */}
        <View
          className="flex-row items-center px-4 pt-2.5"
          style={{
            paddingBottom: 24,
            borderTopWidth: 1,
            borderTopColor: colors.surfaceContainer,
            backgroundColor: colors.surfaceContainerLowest,
          }}
        >
          <CommentAvatar
            author={(canStorePersona && asStore ? user!.businessName : user?.name) || 'You'}
            username={user?.username ?? null}
          />
          <TextInput
            className="flex-1 h-11 px-4 font-inter-400 text-textPrimary ml-2.5"
            style={{ backgroundColor: colors.surfaceContainerLow, borderRadius: 22, fontSize: 14 }}
            placeholder={replyTo ? `Reply to ${replyTo.author}...` : 'Add a comment...'}
            placeholderTextColor={colors.textTertiary}
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />
          <TouchableOpacity
            onPress={submit}
            disabled={!text.trim() || sending}
            className="ml-2 w-11 h-11 items-center justify-center rounded-full"
            style={{ backgroundColor: text.trim() ? colors.primaryContainer : colors.surfaceContainer }}
          >
            <SendIcon size={18} color={text.trim() ? colors.surfaceContainerLowest : colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>
    </BottomSheet>
  );
}

// ─── Likers sheet (long-press the heart) ────────────────────────────────────

export function LikersSheet({
  visible,
  postId,
  onClose,
}: {
  visible: boolean;
  postId: string;
  onClose: () => void;
}) {
  const [likers, setLikers] = useState<Array<{ username: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!visible || !postId) return;
    let alive = true;
    setLoadError(false);
    setLikers([]);
    setLoading(true);
    serverApi.getLikers(postId).then((res) => {
      if (!alive) return;
      if (!res.ok || !res.data || !Array.isArray(res.data.likes)) setLoadError(true);
      else setLikers(res.data.likes);
      setLoading(false);
    }).catch(() => {
      if (!alive) return;
      setLoadError(true);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [visible, postId, reloadKey]);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Likes">
      <View style={{ flex: 1 }}>
        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.primaryContainer} />
          </View>
        ) : loadError ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 15, lineHeight: 20 }}>
              Likes couldn&apos;t load
            </Text>
            <TouchableOpacity className="mt-4 px-5 py-2 rounded-full" style={{ backgroundColor: colors.primaryContainer }} onPress={() => setReloadKey((value) => value + 1)}>
              <Text className="font-inter-600 text-white" style={{ fontSize: 13, lineHeight: 18 }}>
                Try again
              </Text>
            </TouchableOpacity>
          </View>
        ) : likers.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
            <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 15, lineHeight: 20 }}>
              No likes yet
            </Text>
            <Text className="font-inter-400 text-textSecondary text-center mt-1" style={{ fontSize: 13, lineHeight: 18 }}>
              Be the first to like this listing.
            </Text>
          </View>
        ) : (
          <FlatList
            data={likers}
            keyExtractor={(l, i) => `${l.username}-${i}`}
            contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
            renderItem={({ item }) => (
              <View className="flex-row items-center mb-3.5" style={{ gap: 12 }}>
                <View
                  className="w-11 h-11 rounded-full items-center justify-center"
                  style={{ backgroundColor: colors.surfaceContainer }}
                >
                  <UserAvatar name={item.name} username={item.username} size={44} />
                </View>
                <View className="flex-1">
                  <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 14, lineHeight: 18 }} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={1}>
                    @{item.username}
                  </Text>
                </View>
              </View>
            )}
          />
        )}
      </View>
    </BottomSheet>
  );
}

// ─── Share sheet (DMs + communities + external apps) ────────────────────────

export interface ShareTargetPost {
  id: string;
  sellerName: string;
  sellerUsername?: string;
  price: number;
  description: string;
}

export function ShareSheet({
  visible,
  post,
  onClose,
}: {
  visible: boolean;
  post: ShareTargetPost | null;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<Array<{ id: string; name: string; sent?: boolean }>>([]);
  const [communities, setCommunities] = useState<Array<{ id: string; name: string; sent?: boolean }>>([]);
  const [threadsError, setThreadsError] = useState(false);
  const [communitiesError, setCommunitiesError] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingTargets = useRef(new Set<string>());
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);

  const priceLabel = post ? `Rs${post.price.toLocaleString('en-IN')}` : '';

  const shareText = post
    ? `Check out "${post.description.split('#')[0].trim().slice(0, 80)}" for ${priceLabel} by ${post.sellerName}${post.sellerUsername ? ` (@${post.sellerUsername})` : ''} on susej`
    : '';

  useEffect(() => {
    if (!visible || !post) return;
    let alive = true;
    setThreadsError(false);
    setCommunitiesError(false);
    setLoading(true);
    Promise.all([
      serverApi.getThreads().catch(() => ({ ok: false, data: null })),
      serverApi.getCommunities().catch(() => ({ ok: false, data: null })),
    ]).then(([tRes, cRes]) => {
      if (!alive) return;
      if (tRes?.ok && Array.isArray(tRes.data?.threads)) {
        setThreads(tRes.data.threads.map((t: any) => ({
          id: String(t.id),
          name: String(t.name || t.participantName || t.participant || 'Chat'),
        })));
      } else {
        setThreadsError(true);
      }
      if (cRes?.ok && Array.isArray(cRes.data?.communities)) {
        setCommunities(cRes.data.communities.map((c: any) => ({
          id: String(c.id),
          name: String(c.name || 'Community'),
        })));
      } else {
        setCommunitiesError(true);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [visible, post, reloadKey]);

  const sendToThread = async (threadId: string, name: string) => {
    const key = `thread:${threadId}`;
    if (sendingTargets.current.has(key)) return;
    sendingTargets.current.add(key);
    try {
      const res = await serverApi.sendMessage(threadId, shareText);
      if (!res.ok) {
        setSendError(`${name} was not sent. Try again.`);
        return;
      }
      setSendError(null);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, sent: true } : t)));
    } catch {
      setSendError(`${name} was not sent. Try again.`);
    } finally {
      sendingTargets.current.delete(key);
    }
  };

  const sendToCommunity = async (communityId: string) => {
    const key = `community:${communityId}`;
    if (sendingTargets.current.has(key)) return;
    sendingTargets.current.add(key);
    try {
      const res = await serverApi.sendCommunityMessage(communityId, shareText);
      if (!res.ok) {
        setSendError('That community post was not sent. Try again.');
        return;
      }
      setSendError(null);
      setCommunities((prev) => prev.map((c) => (c.id === communityId ? { ...c, sent: true } : c)));
    } catch {
      setSendError('That community post was not sent. Try again.');
    } finally {
      sendingTargets.current.delete(key);
    }
  };

  const externalShare = () => {
    RNShare.share({ message: shareText }).catch(() => {});
  };

  const Row = ({
    label,
    sub,
    sent,
    onPress,
  }: {
    label: string;
    sub?: string;
    sent?: boolean;
    onPress: () => void;
  }) => (
    <TouchableOpacity onPress={onPress} className="flex-row items-center px-4 py-2.5" style={{ gap: 12 }}>
      <View className="w-11 h-11 rounded-full items-center justify-center" style={{ backgroundColor: colors.surfaceContainer }}>
        <Text className="font-inter-600 text-textSecondary" style={{ fontSize: 16, lineHeight: 20 }}>
          {initialsAvatar(label)}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 14, lineHeight: 18 }} numberOfLines={1}>
          {label}
        </Text>
        {sub ? (
          <Text className="font-inter-400 text-textSecondary" style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {sent ? (
        <View className="px-3 py-1.5 rounded-full" style={{ backgroundColor: colors.surfaceContainer }}>
          <Text className="font-inter-600 text-textSecondary" style={{ fontSize: 12, lineHeight: 14 }}>
            Sent
          </Text>
        </View>
      ) : (
        <View className="px-3 py-1.5 rounded-full" style={{ backgroundColor: colors.primaryContainer }}>
          <Text className="font-inter-600 text-white" style={{ fontSize: 12, lineHeight: 14 }}>
            Send
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Share" heightRatio={0.78}>
      <FlatList
        data={[{ key: 'content' }]}
        keyExtractor={(i) => i.key}
        renderItem={() => (
          <View>
            {loading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color={colors.primaryContainer} />
              </View>
            ) : (
              <>
                {sendError ? (
                  <View className="mx-4 mt-3 px-3 py-2 rounded-figma-12" style={{ backgroundColor: colors.errorContainer }}>
                    <Text className="font-inter-500 text-error text-center" style={{ fontSize: 12, lineHeight: 18 }}>
                      {sendError}
                    </Text>
                  </View>
                ) : null}
                {threadsError ? (
                  <View className="px-4 pt-3 items-center">
                    <Text className="font-inter-400 text-textSecondary text-center" style={{ fontSize: 13, lineHeight: 18 }}>
                      Chats couldn&apos;t load.
                    </Text>
                    <TouchableOpacity className="mt-2 px-4 py-2 rounded-full" style={{ backgroundColor: colors.surfaceContainer }} onPress={() => setReloadKey((value) => value + 1)}>
                      <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 12, lineHeight: 16 }}>
                        Try again
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : threads.length > 0 ? (
                  <>
                    <Text className="font-inter-700 text-textPrimary px-4 pt-2 pb-1" style={{ fontSize: 13, lineHeight: 16 }}>
                      Send in a chat
                    </Text>
                    {threads.slice(0, 8).map((t) => (
                      <Row key={t.id} label={t.name} sub="Direct message" sent={t.sent} onPress={() => sendToThread(t.id, t.name)} />
                    ))}
                  </>
                ) : null}
                {communitiesError ? (
                  <View className="px-4 pt-3 items-center">
                    <Text className="font-inter-400 text-textSecondary text-center" style={{ fontSize: 13, lineHeight: 18 }}>
                      Communities couldn&apos;t load.
                    </Text>
                    <TouchableOpacity className="mt-2 px-4 py-2 rounded-full" style={{ backgroundColor: colors.surfaceContainer }} onPress={() => setReloadKey((value) => value + 1)}>
                      <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 12, lineHeight: 16 }}>
                        Try again
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : communities.length > 0 ? (
                  <>
                    <Text className="font-inter-700 text-textPrimary px-4 pt-3 pb-1" style={{ fontSize: 13, lineHeight: 16 }}>
                      Share to communities
                    </Text>
                    {communities.slice(0, 6).map((c) => (
                      <Row key={c.id} label={c.name} sub="Community post" sent={c.sent} onPress={() => sendToCommunity(c.id)} />
                    ))}
                  </>
                ) : null}
                {!threadsError && !communitiesError && threads.length === 0 && communities.length === 0 && (
                  <View style={{ paddingVertical: 28, alignItems: 'center', paddingHorizontal: 32 }}>
                    <Text className="font-inter-400 text-textSecondary text-center" style={{ fontSize: 13, lineHeight: 18 }}>
                      No chats or communities yet — share to other apps below.
                    </Text>
                  </View>
                )}
                <TouchableOpacity
                  onPress={externalShare}
                  className="mx-4 my-4 h-12 rounded-figma-12 items-center justify-center"
                  style={{ backgroundColor: colors.surfaceContainer }}
                >
                  <Text className="font-inter-600 text-textPrimary" style={{ fontSize: 14, lineHeight: 18 }}>
                    Share to other apps
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      />
    </BottomSheet>
  );
}
