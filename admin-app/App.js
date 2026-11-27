import React, { useRef, useState, useEffect } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  ActivityIndicator,
  View,
  BackHandler,
  Platform,
  Text,
  TouchableOpacity,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

const ADMIN_URL = 'https://homestay-silk.vercel.app/admin';

// Configure foreground notifications so admin hears and sees notifications while app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export default function App() {
  const webViewRef = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [pushToken, setPushToken] = useState(null);

  // Setup Push Notifications on mount
  useEffect(() => {
    registerForPushNotificationsAsync().then((token) => {
      if (token) {
        setPushToken(token);
        sendTokenToServer(token);
      }
    });

    // Listen for notification tapped by user
    const responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data;
      if (webViewRef.current) {
        // Switch to pending requests view automatically in the admin dashboard
        webViewRef.current.injectJavaScript(`
          if (typeof switchAdminTab === 'function') {
            switchAdminTab('nav-requests');
          }
          true;
        `);
      }
    });

    return () => {
      Notifications.removeNotificationSubscription(responseListener);
    };
  }, []);

  // Hardware back button support for Android
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const onBackPress = () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [canGoBack]);

  // Inject token into webview once page loads
  const handleWebViewLoadEnd = () => {
    if (pushToken && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        window.__VOLGO_EXPO_PUSH_TOKEN__ = "${pushToken}";
        if (typeof registerExpoPushToken === 'function') {
          registerExpoPushToken("${pushToken}");
        }
        true;
      `);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" backgroundColor="#0f172a" />
      {hasError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Connection Error</Text>
          <Text style={styles.errorSub}>Could not load VolGO Stays Admin.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              setHasError(false);
              webViewRef.current?.reload();
            }}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ uri: ADMIN_URL }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          originWhitelist={['*']}
          startInLoadingState
          onNavigationStateChange={(navState) => setCanGoBack(navState.canGoBack)}
          onLoadEnd={handleWebViewLoadEnd}
          onError={() => setHasError(true)}
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#ea580c" />
              <Text style={styles.loadingText}>Loading VolGO Stays...</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

// Register device with Expo Notification Service
async function registerForPushNotificationsAsync() {
  let token;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('booking-alerts', {
      name: 'Booking Inquiries & Requests',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#ea580c',
      sound: 'default',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.log('Push notification permissions denied by user.');
      return null;
    }

    try {
      const tokenObj = await Notifications.getExpoPushTokenAsync({
        projectId: '95c0de83-7af4-46e1-a84b-177b7daa8850',
      });
      token = tokenObj.data;
      console.log('Obtained Expo Push Token:', token);
    } catch (e) {
      console.error('Error getting Expo push token:', e);
    }
  } else {
    console.log('Must use physical device for Push Notifications');
  }

  return token;
}

// Send token to backend API
async function sendTokenToServer(token) {
  try {
    const deviceName = `${Device.brand || ''} ${Device.modelName || Platform.OS}`.trim();
    await fetch('https://homestay-silk.vercel.app/api/admin/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'expo',
        token,
        deviceName,
        platform: Platform.OS,
      }),
    });
    console.log('Successfully registered Expo push token with backend server.');
  } catch (err) {
    console.warn('Failed to register push token with remote server:', err);
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  webview: { flex: 1, backgroundColor: '#0f172a' },
  loading: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: { color: '#cbd5e1', marginTop: 12, fontSize: 14 },
  errorBox: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorTitle: { color: '#f8fafc', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  errorSub: { color: '#94a3b8', fontSize: 14, marginBottom: 20, textAlign: 'center' },
  retryBtn: { backgroundColor: '#ea580c', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
