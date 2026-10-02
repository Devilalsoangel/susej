import React from 'react';
import { View } from 'react-native';
import { colors } from '../utils/theme';

/**
 * Loading skeleton (industry norm: Instagram/WhatsApp/Amazon never render a
 * half-empty screen while data is in flight).
 *
 * The profile pages used to paint their final layout immediately with zeroed
 * values ("0", "-") and then silently swap in the real numbers a second or two
 * later, which reads as a dead screen rather than a loading one. These blocks
 * are deliberately static - no shimmer loop - so a loading profile never keeps
 * the UI thread busy (a shimmer here is exactly what made `uiautomator dump`
 * fail with "could not get idle state" during device testing).
 */
export function Skeleton({
  width,
  height,
  radius = 8,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  style?: object;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: width ?? '100%',
          height,
          borderRadius: radius,
          backgroundColor: colors.surfaceContainer,
        },
        style,
      ]}
    />
  );
}

/** A round block for avatar placeholders. */
export function SkeletonCircle({ size }: { size: number }) {
  return <Skeleton width={size} height={size} radius={size / 2} />;
}
