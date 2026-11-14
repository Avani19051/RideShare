import React, { useEffect, useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import * as SplashScreen from "expo-splash-screen";
import AsyncStorage from "@react-native-async-storage/async-storage";

import LoginScreen from "./screens/LoginScreen";
import ProfileScreen from "./screens/ProfileScreen";
import CreateTripScreen from "./screens/CreateTripScreen";
import GroupsScreen from "./screens/GroupsScreen";
import GroupDetailsScreen from "./screens/GroupDetailsScreen";

// ✅ FINAL CLEAN BACKEND URL LOGIC
// 1) Vercel/Expo deploy → uses EXPO_PUBLIC_BACKEND_BASE
// 2) Local/Dev → uses Render backend URL
export const BACKEND_BASE =
  (
    process.env.EXPO_PUBLIC_BACKEND_BASE ||
    "https://ucs503p-202526odd-teamkhabu.onrender.com"
  ).replace(/\/+$/, "");

if (__DEV__) {
  console.log("✅ BACKEND_BASE =", BACKEND_BASE);
}

// ---------- Session renewal ----------
// Access tokens last 15 minutes. When an API call comes back 401, swap the
// stored refresh token for a new access token once and retry the call, so
// students aren't logged out mid-use. If renewal fails, the session is cleared
// and the screen's normal "session expired" handling takes over.
const rawFetch = global.fetch.bind(global);
let renewing = null;

async function renewAccessToken() {
  const refreshToken = await AsyncStorage.getItem("refreshToken");
  if (!refreshToken) return null;
  try {
    const r = await rawFetch(`${BACKEND_BASE}/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d?.ok && d.accessToken) {
      await AsyncStorage.setItem("accessToken", d.accessToken);
      return d.accessToken;
    }
    if (r.status === 401) await AsyncStorage.multiRemove(["user", "accessToken", "refreshToken"]);
  } catch {}
  return null;
}

global.fetch = async (input, init = {}) => {
  const res = await rawFetch(input, init);
  const url = typeof input === "string" ? input : input?.url || "";
  if (res.status !== 401 || !url.startsWith(BACKEND_BASE)) return res;
  if (/\/(login|register|token\/refresh|logout)(\?|$)/.test(url)) return res;

  const headers = { ...(init.headers || {}) };
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  if (!authKey) return res;

  renewing = renewing || renewAccessToken().finally(() => { renewing = null; });
  const fresh = await renewing;
  if (!fresh) return res;
  headers[authKey] = `Bearer ${fresh}`;
  return rawFetch(input, { ...init, headers });
};

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// ---------- Bottom Tabs ----------
function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "blue",
        tabBarInactiveTintColor: "gray",
      }}
    >
      <Tab.Screen
        name="Groups"
        component={GroupsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people" size={size} color={color} />
          ),
        }}
      />

      <Tab.Screen
        name="CreateTrip"
        component={CreateTripScreen}
        options={{
          title: "Create Trip",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="add-circle" size={size} color={color} />
          ),
        }}
      />

      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// ---------- App Root ----------
export default function App() {
  const [ready, setReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState("Login");

  useEffect(() => {
    const prepare = async () => {
      await SplashScreen.preventAutoHideAsync();
      // Skip the login screen if a session is already saved
      try {
        const [user, refreshToken] = await Promise.all([
          AsyncStorage.getItem("user"),
          AsyncStorage.getItem("refreshToken"),
        ]);
        if (user && refreshToken) setInitialRoute("Main");
      } catch {}
      setReady(true);
      await SplashScreen.hideAsync();
    };
    prepare();
  }, []);

  if (!ready) return null;

  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName={initialRoute} screenOptions={{ headerShown: false }}>
        
        {/* Login First */}
        <Stack.Screen name="Login" component={LoginScreen} />

        {/* Tabs after login */}
        <Stack.Screen name="Main" component={MainTabs} />

        {/* Group Details */}
        <Stack.Screen
          name="GroupDetails"
          component={GroupDetailsScreen}
          options={{
            headerShown: true,
            title: "Group Details",
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
