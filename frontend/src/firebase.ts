import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";

const env = import.meta.env;

const runtimeEnv =
    typeof window !== "undefined" ? window.__APP_ENV__ ?? {} : {};

const getConfigValue = (key: keyof ImportMetaEnv): string | undefined => {
    const runtimeValue = runtimeEnv[key];
    if (typeof runtimeValue === "string" && runtimeValue.trim()) {
        return runtimeValue.trim();
    }

    const buildValue = env[key];
    if (typeof buildValue === "string" && buildValue.trim()) {
        return buildValue.trim();
    }

    return undefined;
};

const firebaseConfig = {
    apiKey: getConfigValue("VITE_FIREBASE_API_KEY"),
    authDomain: getConfigValue("VITE_FIREBASE_AUTH_DOMAIN"),
    projectId: getConfigValue("VITE_FIREBASE_PROJECT_ID"),
    storageBucket: getConfigValue("VITE_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: getConfigValue("VITE_FIREBASE_MESSAGING_SENDER_ID"),
    appId: getConfigValue("VITE_FIREBASE_APP_ID"),
    measurementId: getConfigValue("VITE_FIREBASE_MEASUREMENT_ID"),
};

const requiredKeys: Array<keyof typeof firebaseConfig> = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
];

const missingKeys = requiredKeys.filter((key) => !firebaseConfig[key]);

if (missingKeys.length > 0) {
    console.error(
        `Firebase config missing required values: ${missingKeys.join(", ")}. ` +
            "Set VITE_FIREBASE_* values via frontend/.env.production or container environment."
    );
}

if (!firebaseConfig.projectId) {
    console.warn("Firebase projectId is missing (VITE_FIREBASE_PROJECT_ID). Analytics will be disabled.");
}

const app = initializeApp(firebaseConfig);

const canUseAnalytics =
    typeof window !== "undefined" &&
    !!firebaseConfig.projectId &&
    !!firebaseConfig.measurementId;

if (canUseAnalytics) {
    try {
        getAnalytics(app);
    } catch (err) {
        console.warn("Firebase Analytics init skipped:", err);
    }
}

export const auth = getAuth(app);

