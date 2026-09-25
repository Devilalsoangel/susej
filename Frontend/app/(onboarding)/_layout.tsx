import { Stack } from 'expo-router';

export default function OnboardingLayout() {
  return (
    <Stack
      initialRouteName="location"
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
    />
  );
}
