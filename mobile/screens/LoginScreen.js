import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BACKEND_BASE } from "../App";

async function safeFetch(url, opts = {}) {
  try {
    const resp = await fetch(url, opts);
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = { ok: resp.ok, error: "Unexpected response from server" };
    }
    return { resp, data };
  } catch (e) {
    return { resp: null, data: { ok: false, error: "network" } };
  }
}

// Same rules as the backend, so most mistakes are caught before sending
const EMAIL_RE = /^[a-z0-9._%+-]+@thapar\.edu$/;
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,59}$/;
const ROLL_RE = /^[0-9]{6,12}$/;

function passwordProblem(pw) {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 72) return "Password must be at most 72 characters.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw))
    return "Password needs at least one letter and one number.";
  return null;
}

// Turn server / network errors into friendly sentences
function friendly(err, status) {
  if (!status || err === "network")
    return "Can't reach the server. Check your internet connection and try again.";
  const e = String(err || "").toLowerCase();
  if (status === 429) return err || "Too many attempts. Please wait a few minutes and try again.";
  if (e.includes("incorrect email or password") || e.includes("invalid credentials"))
    return "Incorrect email or password.";
  if (e.includes("email already exists")) return "An account with this email already exists. Try logging in.";
  if (e.includes("roll number is already registered")) return "This roll number is already registered.";
  if (status >= 500) return "Something went wrong on the server. Please try again.";
  return err ? err.charAt(0).toUpperCase() + err.slice(1) : "Something went wrong.";
}

export default function LoginScreen({ navigation }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [name, setName] = useState("");
  const [gender, setGender] = useState("");
  const [year, setYear] = useState("");
  const [rollNo, setRollNo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const normEmail = () => email.trim().toLowerCase();

  function switchMode(m) {
    setMode(m);
    setError("");
    setFieldErrors({});
    setPassword("");
  }

  async function saveSession(data) {
    await AsyncStorage.setItem("user", JSON.stringify(data.user));
    if (data.accessToken) await AsyncStorage.setItem("accessToken", data.accessToken);
    if (data.refreshToken) await AsyncStorage.setItem("refreshToken", data.refreshToken);
    navigation.replace("Main");
  }

  async function handleLogin() {
    if (loading) return;
    const e = normEmail();
    const errs = {};
    if (!e) errs.email = "Enter your Thapar email.";
    else if (!EMAIL_RE.test(e)) errs.email = "Use a valid @thapar.edu email.";
    if (!password) errs.password = "Enter your password.";
    setFieldErrors(errs);
    setError("");
    if (Object.keys(errs).length) return;

    setLoading(true);
    const { resp, data } = await safeFetch(`${BACKEND_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: e, password }),
    });
    setLoading(false);
    if (!resp || !resp.ok || !data?.ok) return setError(friendly(data?.error, resp?.status));
    await saveSession(data);
  }

  async function handleRegister() {
    if (loading) return;
    const e = normEmail();
    const n = name.replace(/\s+/g, " ").trim();
    const r = rollNo.trim();
    const y = year.trim();
    const errs = {};
    if (!NAME_RE.test(n)) errs.name = "Enter your full name (letters only).";
    if (!ROLL_RE.test(r)) errs.rollNo = "Roll number should be 6–12 digits.";
    if (!EMAIL_RE.test(e)) errs.email = "Use a valid @thapar.edu email.";
    const pw = passwordProblem(password);
    if (pw) errs.password = pw;
    if (!["M", "F"].includes(gender)) errs.gender = "Select Male or Female.";
    if (!/^[1-5]$/.test(y)) errs.year = "Year must be a number from 1 to 5.";
    setFieldErrors(errs);
    setError("");
    if (Object.keys(errs).length) return;

    setLoading(true);
    const { resp, data } = await safeFetch(`${BACKEND_BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: e, password, name: n, gender, year: parseInt(y, 10), rollNo: r }),
    });
    setLoading(false);
    if (!resp || !resp.ok || !data?.ok) return setError(friendly(data?.error, resp?.status));
    // Registration also signs the student in
    await saveSession(data);
  }

  const FieldError = ({ k }) =>
    fieldErrors[k] ? <Text style={styles.fieldError}>{fieldErrors[k]}</Text> : null;

  const inputStyle = (k) => [styles.inputRow, fieldErrors[k] && styles.inputRowError];

  const PasswordInput = (
    <>
      <View style={inputStyle("password")}>
        <Ionicons name="lock-closed-outline" size={20} color="#555" />
        <TextInput
          placeholder={mode === "login" ? "Password" : "Password (8+ chars, letters & numbers)"}
          value={password}
          onChangeText={(t) => { setPassword(t); setFieldErrors((f) => ({ ...f, password: undefined })); }}
          style={styles.input}
          secureTextEntry={!showPw}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={mode === "login" ? handleLogin : undefined}
        />
        <TouchableOpacity onPress={() => setShowPw((v) => !v)} accessibilityLabel={showPw ? "Hide password" : "Show password"}>
          <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={20} color="#777" />
        </TouchableOpacity>
      </View>
      <FieldError k="password" />
    </>
  );

  return (
    <LinearGradient colors={["#e0f7fa", "#e1bee7"]} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Ionicons name="car-outline" size={48} color="#E53935" />
          <Text style={styles.title}>RideShare</Text>
          <Text style={styles.subtitle}>{mode === "login" ? "Login with your Thapar email" : "Create your account"}</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color="#b71c1c" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {mode === "register" && (
            <>
              <View style={inputStyle("name")}>
                <Ionicons name="person-outline" size={20} color="#555" />
                <TextInput placeholder="Full name" value={name} style={styles.input}
                  onChangeText={(t) => { setName(t); setFieldErrors((f) => ({ ...f, name: undefined })); }} />
              </View>
              <FieldError k="name" />

              <View style={inputStyle("rollNo")}>
                <Ionicons name="id-card-outline" size={20} color="#555" />
                <TextInput placeholder="Roll No (e.g., 102303195)" value={rollNo} style={styles.input}
                  keyboardType="number-pad" maxLength={12}
                  onChangeText={(t) => { setRollNo(t.replace(/[^0-9]/g, "")); setFieldErrors((f) => ({ ...f, rollNo: undefined })); }} />
              </View>
              <FieldError k="rollNo" />
            </>
          )}

          <View style={inputStyle("email")}>
            <Ionicons name="mail-outline" size={20} color="#555" />
            <TextInput
              placeholder="name_be23@thapar.edu"
              value={email}
              onChangeText={(t) => { setEmail(t); setFieldErrors((f) => ({ ...f, email: undefined })); }}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
          </View>
          <FieldError k="email" />

          {PasswordInput}

          {mode === "register" && (
            <>
              <View style={{ flexDirection: "row", gap: 10, width: "100%" }}>
                {["M", "F"].map((g) => (
                  <TouchableOpacity
                    key={g}
                    onPress={() => { setGender(g); setFieldErrors((f) => ({ ...f, gender: undefined })); }}
                    style={[styles.genderBtn, gender === g && styles.genderBtnActive, fieldErrors.gender && styles.inputRowError]}
                  >
                    <Text style={{ fontWeight: "700", color: gender === g ? "#E53935" : "#333" }}>{g === "M" ? "Male" : "Female"}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <FieldError k="gender" />

              <View style={[inputStyle("year"), { marginTop: 12 }]}>
                <Ionicons name="school-outline" size={20} color="#555" />
                <TextInput placeholder="Year (1–5)" value={year} style={styles.input}
                  keyboardType="number-pad" maxLength={1}
                  onChangeText={(t) => { setYear(t.replace(/[^0-9]/g, "")); setFieldErrors((f) => ({ ...f, year: undefined })); }}
                  onSubmitEditing={handleRegister} />
              </View>
              <FieldError k="year" />
            </>
          )}

          <TouchableOpacity
            style={[styles.button, loading && { opacity: 0.7 }]}
            onPress={mode === "login" ? handleLogin : handleRegister}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>{mode === "login" ? "Login" : "Register"}</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => switchMode(mode === "login" ? "register" : "login")}>
            <Text style={styles.link}>{mode === "login" ? "New user? Register here" : "Already have an account? Login"}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingVertical: 24 },
  card: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 20,
    padding: 25,
    width: "85%",
    maxWidth: 480,
    alignItems: "center",
  },
  title: { fontSize: 28, fontWeight: "700", color: "#E53935", marginBottom: 10 },
  subtitle: { fontSize: 14, color: "#555", marginBottom: 16 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 10,
    paddingHorizontal: 10,
    marginTop: 12,
    backgroundColor: "white",
    width: "100%",
  },
  inputRowError: { borderColor: "#e53935", backgroundColor: "#fff5f5" },
  input: { flex: 1, padding: 10 },
  fieldError: { alignSelf: "flex-start", color: "#c62828", fontSize: 12, marginTop: 4 },
  errorBox: {
    flexDirection: "row", alignItems: "center", gap: 8, width: "100%",
    backgroundColor: "#ffebee", borderColor: "#ffcdd2", borderWidth: 1,
    borderRadius: 10, padding: 10, marginBottom: 4,
  },
  errorText: { color: "#b71c1c", flex: 1, fontWeight: "600" },
  genderBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1,
    borderColor: "#e2e8f0", backgroundColor: "#f8fafc", alignItems: "center", marginTop: 12,
  },
  genderBtnActive: { backgroundColor: "#fee2e2", borderColor: "#E53935" },
  button: { backgroundColor: "#E53935", paddingVertical: 12, borderRadius: 10, width: "100%", marginTop: 18 },
  btnText: { color: "#fff", textAlign: "center", fontWeight: "700" },
  link: { color: "#1976D2", marginTop: 12, fontWeight: "600" },
});
