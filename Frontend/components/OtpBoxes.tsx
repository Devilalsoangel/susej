import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { colors } from '../utils/theme';

const BOX = 6;

/**
 * OTP entry with individually tappable boxes.
 *
 * The boxes are VIEWS. A single TextInput owns the whole string, overlaid
 * transparently across them. That is the whole point:
 *
 *  - Six independently-focused inputs race each other. A keystroke that lands
 *    while the programmatic focus move is still in flight is applied to the box
 *    that just lost focus and then reverted, so the character disappears. That
 *    is not theoretical: typing 818955 produced 81855, and 533924 produced
 *    537. Letting the caret move after the value is committed makes the loss
 *    window small but never closed.
 *  - One input has one focus, so every character is applied atomically to the
 *    value. Fast typing, SMS autofill and paste all work.
 *
 * Each box is still individually tappable: pressing one focuses the input and
 * places the caret at that position, so an existing digit can be corrected in
 * place.
 */
export function OtpBoxes({
  code,
  onChange,
  onComplete,
  autoFocus = false,

  invalid = false,
  disabled = false,
  accessibilityLabel = '6-digit verification code',
}: {
  code: string[];
  onChange: (next: string[]) => void;
  onComplete: (full: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  accessibilityLabel?: string;
}) {
  const value = code.filter(Boolean).join('');
  const inputRef = useRef<TextInput>(null);
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [caret, setCaret] = useState(0);

  // Publish to the parent as an array so both auth screens keep their existing
  // shape, but keep a ref as the internal source of truth: onChangeText can fire
  // faster than React re-renders, and reading a stale prop there is how digits
  // get lost.
  const valueRef = useRef(value);
  const publish = (next: string) => {
    valueRef.current = next;
    onChange(Array.from({ length: BOX }, (_, i) => next[i] ?? ''));
  };

  useEffect(() => {
    // Adopt external clears (a fresh challenge resets the code).
    if (value === '' && valueRef.current !== '') {
      valueRef.current = '';
      setCaret(0);
    }
  }, [value]);

  useEffect(() => {
    if (submitTimer.current) clearTimeout(submitTimer.current);
    return () => {
      if (submitTimer.current) clearTimeout(submitTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!autoFocus) {
      inputRef.current?.blur();
      setCaret(0);
      return;
    }
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      setCaret(0);
    }, 280);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  const placeCaret = (index: number) => {
    const i = Math.min(valueRef.current.length, Math.max(0, index));
    setCaret(i);
    // Imperative, not a controlled `selection` prop: driving `selection` from
    // state fights the IME on Android and causes visible caret jumps.
    try {
      inputRef.current?.setNativeProps({ selection: { start: i, end: i } });
    } catch {}
  };

  const handleChange = (raw: string) => {
    if (disabled) return;
    const digits = String(raw ?? '').replace(/\D/g, '').slice(0, BOX);
    const grew = digits.length > valueRef.current.length;
    publish(digits);
    if (grew) {
      placeCaret(digits.length);
    } else {
      setCaret(Math.min(digits.length, caret));
    }
    if (digits.length === BOX) {
      if (submitTimer.current) clearTimeout(submitTimer.current);
      submitTimer.current = setTimeout(() => onComplete(digits), 150);
    }
  };

  const pressBox = (index: number) => {
    if (disabled) return;
    inputRef.current?.focus();
    // Tapping a filled box puts the caret AFTER its digit so the next key edits
    // that digit; tapping the next empty box simply appends.
    placeCaret(Math.min(BOX, index + (valueRef.current[index] ? 1 : 0)));
  };

  return (
    <View accessibilityLabel={accessibilityLabel} style={{ position: 'relative' }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {Array.from({ length: BOX }, (_, index) => {
          const digit = valueRef.current[index] ?? '';
          const active = caret === index;
          return (
            <Pressable
              key={index}
              onPress={() => pressBox(index)}
              accessibilityRole="button"
              accessibilityLabel={`Digit ${index + 1} of ${BOX}${digit ? `, ${digit}` : ', empty'}`}
              style={{
                flex: 1,
                height: 56,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.surfaceContainer,
                // Empty boxes had NO border at all (transparent / width 0), so
                // they only read as a pale fill - gpt vision: "OTP boxes visible
                // but very low-contrast empty state... slightly too rounded and
                // soft compared with mature commerce apps". Always draw a
                // visible resting border, tighten the corner to 12, and use
                // `outline` rather than `outlineVariant` (#c7c4d7 on #fcf8ff is
                // only ~1.5:1 - the follow-up note asked for more contrast).
                borderWidth: 1.5,
                borderColor: invalid
                  ? colors.error
                  : active
                  ? colors.primary
                  : digit
                    ? colors.primaryContainer
                    : colors.outline,
              }}
            >
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: '600',
                  color: colors.textPrimary,
                }}
              >
                {digit}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* The one real input: invisible, spanning the row. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        onSelectionChange={(e) => setCaret(e.nativeEvent.selection.start)}
        editable={!disabled}
        keyboardType="number-pad"
        maxLength={BOX}
        autoCorrect={false}
        autoCapitalize="none"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        importantForAutofill="yes"
        caretHidden
        accessibilityLabel={accessibilityLabel}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          opacity: 0.01,
        }}
      />
    </View>
  );
}
