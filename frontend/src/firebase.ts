import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";

const env = import.meta.env;

const firebaseConfig = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
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

