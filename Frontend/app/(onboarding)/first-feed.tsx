import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, BackHandler } from 'react-native';
import { ArrowRightIcon } from '../../utils/icons';
import { colors } from '../../utils/theme';
import { useAuth } from '../../contexts/AuthContext';
import { replaceRoute } from '../../utils/navigation';

export default function FirstFeedScreen() {
  const { completeOnboarding, user } = useAuth();
  const finishing = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [finishError, setFinishError] = useState('');

  // Fail closed. Every control here writes through the session, so a screen
  // that renders without a live user presents a full, interactive UI whose
  // only button can never succeed - with the back gesture swallowed on top.
  if (!user) return null;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const startExploring = async () => {
    if (finishing.current) return;
    finishing.current = true;
    setSubmitting(true);
    setFinishError('');
    try {
      const completed = await completeOnboarding();
      if (!completed) {
        setFinishError('Could not finish setup. Please try again.');
        finishing.current = false;
        setSubmitting(false);
        return;
      }
      const navigated = await replaceRoute('/(tabs)/feed');
      if (!navigated) {
        setFinishError('Could not open your feed. Please try again.');
        finishing.current = false;
        setSubmitting(false);
      }
    } catch {
      setFinishError('Could not finish setup. Please try again.');
      finishing.current = false;
      setSubmitting(false);
    }
  };

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      <View className="items-center pt-16 pb-4">
        <Text
          className="font-inter-700"
          style={{ fontSize: 28, lineHeight: 36, letterSpacing: -0.7, color: colors.primary }}
        >
          susej
        </Text>
      </View>

      <View className="flex-1 justify-center px-8" style={{ gap: 16 }}>
        <Text
          className="font-inter-700 text-center"
          style={{ fontSize: 28, lineHeight: 36, letterSpacing: -0.56, color: colors.textPrimary }}
        >
          You're all set!
        </Text>
        <Text
          className="font-inter-400 text-center"
          style={{ fontSize: 16, lineHeight: 24, color: colors.textSecondary }}
        >
          Your feed is ready. Start exploring products from sellers near you.
        </Text>
      </View>

      <View className="px-8 pb-12">
        {finishError ? (
          <Text
            className="font-inter-500 text-center mb-3"
            style={{ fontSize: 13, lineHeight: 18, color: colors.error }}
          >
            {finishError}
          </Text>
        ) : null}
        <TouchableOpacity
          className="w-full h-14 flex-row items-center justify-center rounded-figma-16"
          style={{ backgroundColor: colors.primaryContainer, opacity: submitting ? 0.7 : 1 }}
          onPress={() => void startExploring()}
          disabled={submitting}
        >
          <Text
            className="font-inter-600 mr-2"
            style={{ fontSize: 16, lineHeight: 20, letterSpacing: 0.16, color: '#FFFFFF' }}
          >
            {submitting ? 'Opening…' : 'Start Exploring'}
          </Text>
          <ArrowRightIcon size={10} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}
