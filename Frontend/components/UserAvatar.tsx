import React, { useState } from 'react';
import { View, Image, type StyleProp, type ViewStyle } from 'react-native';

import { AvatarView } from './AvatarView';
import { useAvatarUrl, isRealAvatar } from '../utils/avatarDirectory';

/**
 * The one avatar every screen uses.
 *
 * A profile picture has exactly two honest states: the account's real photo, or
 * initials on a colour. The third state - a blank circle - is what users report
 * as "PFP not showing", and it happened because render sites passed
 * `resolveAvatar()`, which returns ONE shared empty placeholder for everybody
 * (even accounts that have a photo).
 *
 * Behaviour:
 * - `uri` (already-known photo) wins; otherwise the username is resolved
 *   through the shared avatar directory (one request per username per device).
 * - Until the photo arrives, initials are drawn - never an empty frame.
 * - A photo that FAILS to load (dead Cloudinary URL, offline) falls back to
 *   initials too, so a broken URL can never leave a hole in the UI.
 */
export function UserAvatar({
  name,
  username,
  uri,
  size = 40,
  className = '',
  style,
  ring = false,
}: {
  /** Display name, used for the initials. */
  name: string;
  /** Account handle - the directory key. */
  username?: string | null;
  /** A photo already in hand (post payload, session user, server row). */
  uri?: string | null;
  size?: number;
  className?: string;
  style?: StyleProp<ViewStyle>;
  ring?: boolean;
}) {
  const known = isRealAvatar(uri) ? uri : null;
  const resolved = useAvatarUrl(username);
  const photo = known ?? resolved;
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = !!photo && broken !== photo;

  const box: StyleProp<ViewStyle> = {
    width: size,
    height: size,
    borderRadius: size / 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <View className={className} style={[box, ring ? { padding: 3, backgroundColor: '#5d5fef' } : null, style]}>
      {ring ? (
        <View style={[box, { width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }]}>
          <Inner name={name} photo={showPhoto ? photo : null} onBroken={setBroken} size={size} />
        </View>
      ) : (
        <Inner name={name} photo={showPhoto ? photo : null} onBroken={setBroken} size={size} />
      )}
    </View>
  );
}

function Inner({
  name,
  photo,
  onBroken,
  size,
}: {
  name: string;
  photo: string | null;
  onBroken: (uri: string) => void;
  size: number;
}) {
  if (photo) {
    return (
      <Image
        source={{ uri: photo }}
        onError={() => onBroken(photo)}
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    );
  }
  return <AvatarView name={name || 'susej'} size={size} />;
}
